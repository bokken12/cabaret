//! GitHub pull requests, read as the history of events that importing records in a change's log.

use std::process::Command;

use cabaret_types::{
    ChangeId, Identity, Result, Reviewing, TimestampS,
    log::{ForgeEvent, LogAction},
};
use curl::easy::{Easy, List};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;

/// The GraphQL query answered by a [`Response`]; takes `owner`, `name`, `number`, and `after`, the
/// cursor its page of events follows.
pub const TIMELINE_QUERY: &str = include_str!("timeline.graphql");

#[derive(Debug, Deserialize)]
pub struct Response {
    pub data: Option<Data>,
    #[serde(default)]
    pub errors: Vec<ResponseError>,
}

#[derive(Debug, Deserialize)]
pub struct ResponseError {
    pub message: String,
}

impl Response {
    /// The pull request asked for, unless GitHub answered with errors instead.
    pub fn pull_request(self) -> Result<PullRequest> {
        let pull_request = self.data.and_then(|data| data.repository).and_then(|repository| repository.pull_request);
        match pull_request {
            Some(pull_request) if self.errors.is_empty() => Ok(pull_request),
            _ => {
                let messages: Vec<_> = self.errors.into_iter().map(|error| error.message).collect();
                Err(format!("GitHub refused the query: {}", messages.join("; ")))?
            }
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Data {
    pub repository: Option<Repository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub pull_request: Option<PullRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: String,
    pub created_at: String,
    pub title: String,
    pub is_draft: bool,
    pub base_ref_name: String,
    pub head_ref_name: String,
    /// Whether the head branch lives in a fork rather than beside the base.
    pub is_cross_repository: bool,
    pub author: Option<Actor>,
    pub timeline_items: TimelineItems,
}

/// `None` wherever GitHub gives one stands for an account since deleted.
#[derive(Debug, Deserialize)]
pub struct Actor {
    pub login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItems {
    pub page_info: PageInfo,
    pub nodes: Vec<TimelineItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
pub enum TimelineItem {
    RenamedTitleEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
        previous_title: String,
        current_title: String,
    },
    BaseRefChangedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
        previous_ref_name: String,
        current_ref_name: String,
    },
    ReviewRequestedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
        requested_reviewer: Option<Reviewer>,
    },
    ReviewRequestRemovedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
        requested_reviewer: Option<Reviewer>,
    },
    PullRequestReview {
        id: String,
        submitted_at: Option<String>,
        author: Option<Actor>,
        state: ReviewState,
    },
    ReviewDismissedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
        review: Option<Review>,
    },
    ReadyForReviewEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
    },
    ConvertToDraftEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
    },
    ReopenedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
    },
    ClosedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
    },
    MergedEvent {
        id: String,
        created_at: String,
        actor: Option<Actor>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename")]
pub enum Reviewer {
    User {
        login: String,
    },
    // TODO-someday(joel): a team asked to review has no identity to become an owner as.
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct Review {
    pub author: Option<Actor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    #[serde(other)]
    Other,
}

// TODO-someday(joel): a login can be renamed, after which the same event imports as a different
// commit; the account's numeric id never changes, but is not what people write.
fn identity(actor: Option<&Actor>) -> Identity {
    Identity(format!("github:{}", actor.map_or("ghost", |actor| &actor.login)))
}

fn time(timestamp: &str) -> Result<TimestampS> { Ok(timestamp.parse::<jiff::Timestamp>()?.as_second()) }

fn event(id: &str, at: &str, actor: Option<&Actor>, actions: Vec<LogAction>) -> Result<ForgeEvent> {
    Ok(ForgeEvent { id: id.parse()?, author: identity(actor), time: time(at)?, actions })
}

impl PullRequest {
    /// The change this is the forge change of: the one named for its head branch.
    pub fn change(&self) -> Result<ChangeId> { Ok(self.head_ref_name.parse()?) }

    /// This pull request's history as the events importing records, oldest first. Opening it is
    /// the first, under the pull request's own id, and sets what later events then change: GitHub
    /// keeps no event for it, so how it began is read back from the first event to change each.
    // TODO-someday(joel): what a review asks of its author's files is not recorded: owners are to
    // endorse, and may come to review only what they choose to.
    pub fn events(&self) -> Result<Vec<ForgeEvent>> {
        if self.timeline_items.page_info.has_next_page {
            Err(format!("pull request {} is missing the later pages of its events", self.id))?;
        }
        let items = &self.timeline_items.nodes;
        let title = items.iter().find_map(|item| match item {
            TimelineItem::RenamedTitleEvent { previous_title, .. } => Some(previous_title),
            _ => None,
        });
        let base = items.iter().find_map(|item| match item {
            TimelineItem::BaseRefChangedEvent { previous_ref_name, .. } => Some(previous_ref_name),
            _ => None,
        });
        let draft = items.iter().find_map(|item| match item {
            TimelineItem::ReadyForReviewEvent { .. } => Some(true),
            TimelineItem::ConvertToDraftEvent { .. } => Some(false),
            _ => None,
        });
        let author = identity(self.author.as_ref());
        let mut events = vec![event(
            &self.id,
            &self.created_at,
            self.author.as_ref(),
            vec![
                LogAction::AddOwner { owner: author },
                LogAction::SetTitle { title: Some(title.unwrap_or(&self.title).clone()) },
                LogAction::AddParent { parent: base.unwrap_or(&self.base_ref_name).parse()? },
                LogAction::SetReviewing { reviewing: reviewing(draft.unwrap_or(self.is_draft)) },
            ],
        )?];
        for item in items {
            events.extend(item.event()?);
        }
        Ok(events)
    }
}

/// A draft is still being written; anything else is up for review.
fn reviewing(draft: bool) -> Reviewing {
    match draft {
        true => Reviewing::None,
        false => Reviewing::Owners,
    }
}

impl TimelineItem {
    /// `None` for an event that changes nothing a change records.
    fn event(&self) -> Result<Option<ForgeEvent>> {
        let (id, at, actor, actions) = match self {
            Self::RenamedTitleEvent { id, created_at, actor, current_title, .. } => {
                (id, created_at, actor, vec![LogAction::SetTitle { title: Some(current_title.clone()) }])
            }
            Self::BaseRefChangedEvent { id, created_at, actor, previous_ref_name, current_ref_name } => (
                id,
                created_at,
                actor,
                vec![
                    LogAction::RemoveParent { parent: previous_ref_name.parse()? },
                    LogAction::AddParent { parent: current_ref_name.parse()? },
                ],
            ),
            Self::ReviewRequestedEvent {
                id,
                created_at,
                actor,
                requested_reviewer: Some(Reviewer::User { login }),
            } => (id, created_at, actor, vec![LogAction::AddOwner { owner: Identity(format!("github:{login}")) }]),
            Self::ReviewRequestRemovedEvent {
                id,
                created_at,
                actor,
                requested_reviewer: Some(Reviewer::User { login }),
            } => (id, created_at, actor, vec![LogAction::RemoveOwner { owner: Identity(format!("github:{login}")) }]),
            Self::PullRequestReview { id, submitted_at: Some(submitted_at), author, state } => {
                let reviewer = identity(author.as_ref());
                let verdict = match state {
                    ReviewState::Approved => LogAction::Endorse { endorser: reviewer.clone() },
                    ReviewState::ChangesRequested => LogAction::Unendorse { endorser: reviewer.clone() },
                    ReviewState::Other => return Ok(None),
                };
                (id, submitted_at, author, vec![LogAction::AddOwner { owner: reviewer }, verdict])
            }
            Self::ReviewDismissedEvent { id, created_at, actor, review: Some(review) } => {
                (id, created_at, actor, vec![LogAction::Unendorse { endorser: identity(review.author.as_ref()) }])
            }
            Self::ReadyForReviewEvent { id, created_at, actor } => {
                (id, created_at, actor, vec![LogAction::SetReviewing { reviewing: reviewing(false) }])
            }
            Self::ConvertToDraftEvent { id, created_at, actor } => {
                (id, created_at, actor, vec![LogAction::SetReviewing { reviewing: reviewing(true) }])
            }
            Self::ReopenedEvent { id, created_at, actor } => {
                (id, created_at, actor, vec![LogAction::SetArchived { archived: false }])
            }
            Self::ClosedEvent { id, created_at, actor } | Self::MergedEvent { id, created_at, actor } => {
                (id, created_at, actor, vec![LogAction::SetArchived { archived: true }])
            }
            Self::ReviewRequestedEvent { .. }
            | Self::ReviewRequestRemovedEvent { .. }
            | Self::PullRequestReview { .. }
            | Self::ReviewDismissedEvent { .. }
            | Self::Other => return Ok(None),
        };
        event(id, at, actor.as_ref(), actions).map(Some)
    }
}

/// A pull request as listing finds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Updated {
    pub number: u64,
    /// When anything about the pull request last changed, its events included.
    pub at: TimestampS,
}

#[derive(Debug, Deserialize)]
struct Listed {
    number: u64,
    updated_at: String,
}

const API: &str = "https://api.github.com";
/// How many pull requests one page of a listing holds, the most GitHub allows.
const PER_PAGE: usize = 100;

/// A repository on GitHub, reached through its API.
pub struct GitHub {
    token: String,
    owner: String,
    name: String,
}

impl GitHub {
    /// The owner and name of the repository `url` fetches from; `None` when it is not GitHub's.
    pub fn repository(url: &str) -> Option<(&str, &str)> {
        let path = ["git@github.com:", "ssh://git@github.com/", "https://github.com/"]
            .iter()
            .find_map(|prefix| url.strip_prefix(prefix))?;
        let (owner, name) = path.strip_suffix('/').unwrap_or(path).split_once('/')?;
        let name = name.strip_suffix(".git").unwrap_or(name);
        (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then_some((owner, name))
    }

    /// Reach `owner`'s repository `name` as whoever `GITHUB_TOKEN` authenticates, or else whoever
    /// `gh` is logged in as.
    pub fn connect(owner: &str, name: &str) -> Result<Self> {
        Ok(Self { token: token()?, owner: owner.to_owned(), name: name.to_owned() })
    }

    /// The pull requests changed at or after `since`, open or not; without `since`, those open now.
    pub fn updated(&self, since: Option<TimestampS>) -> Result<Vec<Updated>> {
        let state = match since {
            Some(_) => "all",
            None => "open",
        };
        let mut updated = Vec::new();
        for page in 1.. {
            let url = format!(
                "{API}/repos/{}/{}/pulls?state={state}&sort=updated&direction=desc&per_page={PER_PAGE}&page={page}",
                self.owner, self.name
            );
            let listed: Vec<Listed> = self.request(&url, None)?;
            for pull_request in &listed {
                let at = time(&pull_request.updated_at)?;
                if since.is_some_and(|since| at < since) {
                    return Ok(updated);
                }
                updated.push(Updated { number: pull_request.number, at });
            }
            if listed.len() < PER_PAGE {
                break;
            }
        }
        Ok(updated)
    }

    /// Pull request `number` with every page of its events.
    pub fn pull_request(&self, number: u64) -> Result<PullRequest> {
        let mut after: Option<String> = None;
        let mut earlier = Vec::new();
        loop {
            let variables = json!({ "owner": self.owner, "name": self.name, "number": number, "after": after });
            let query = serde_json::to_vec(&json!({ "query": TIMELINE_QUERY, "variables": variables }))?;
            let response: Response = self.request(&format!("{API}/graphql"), Some(&query))?;
            let mut pull_request = response.pull_request()?;
            earlier.append(&mut pull_request.timeline_items.nodes);
            if !pull_request.timeline_items.page_info.has_next_page {
                pull_request.timeline_items.nodes = earlier;
                return Ok(pull_request);
            }
            let cursor = pull_request.timeline_items.page_info.end_cursor;
            after = Some(cursor.ok_or("GitHub promised a next page of events without saying where it starts")?);
        }
    }

    /// What GitHub answers at `url`: to a POST of `body` when given, else to a GET.
    fn request<T: DeserializeOwned>(&self, url: &str, body: Option<&[u8]>) -> Result<T> {
        let mut headers = List::new();
        headers.append(&format!("Authorization: Bearer {}", self.token))?;
        headers.append("Accept: application/vnd.github+json")?;
        // GitHub refuses requests that do not say what sent them.
        headers.append("User-Agent: cabaret")?;
        let mut easy = Easy::new();
        easy.url(url)?;
        easy.http_headers(headers)?;
        if let Some(body) = body {
            easy.post(true)?;
            easy.post_fields_copy(body)?;
        }
        let mut answer = Vec::new();
        {
            let mut transfer = easy.transfer();
            transfer.write_function(|data| {
                answer.extend_from_slice(data);
                Ok(data.len())
            })?;
            transfer.perform()?;
        }
        let status = easy.response_code()?;
        if !(200..300).contains(&status) {
            Err(format!("GitHub answered {status} at {url}: {}", String::from_utf8_lossy(&answer).trim_end()))?;
        }
        Ok(serde_json::from_slice(&answer)?)
    }
}

fn token() -> Result<String> {
    if let Ok(token) = std::env::var("GITHUB_TOKEN")
        && !token.is_empty()
    {
        return Ok(token);
    }
    let gh = Command::new("gh").args(["auth", "token"]).output();
    match gh {
        Ok(gh) if gh.status.success() => Ok(String::from_utf8(gh.stdout)?.trim().to_owned()),
        _ => Err("no GitHub token: set GITHUB_TOKEN or log in with `gh auth login`")?,
    }
}
