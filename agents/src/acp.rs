//! Sessions listed by an agent over the Agent Client Protocol (ACP), spoken as JSON-RPC over the
//! agent's stdio. Only `initialize` and `session/list` are used, one request at a time, so the
//! exchange is a plain write-then-read loop rather than a full client.

use std::{
    io::{BufRead, BufReader, Lines, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use agent_client_protocol_schema::{
    ProtocolVersion,
    rpc::{JsonRpcMessage, Request, Response},
    v1::{Implementation, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse},
};
use cabaret_types::{Result, TimestampMs};
use serde::{Serialize, de::DeserializeOwned};

use crate::{Session, SessionId};

pub struct Acp {
    command: PathBuf,
}

struct Connection {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: i64,
}

impl Acp {
    /// `command` starts the agent speaking ACP on its stdio, e.g. `claude-agent-acp`.
    pub fn new(command: PathBuf) -> Self { Self { command } }

    /// Sessions launched from `dir`, most recently active first. The agent decides what to report
    /// for a directory; Claude Code's adapter also includes sibling git worktrees, so the launch
    /// directory each session reports is checked here.
    pub fn sessions_in(&self, dir: &Path) -> Result<Vec<Session>> {
        let mut connection = Connection::open(&self.command)?;
        let initialized: InitializeResponse = connection.call(
            "initialize",
            InitializeRequest::new(ProtocolVersion::V1)
                .client_info(Implementation::new("cabaret", env!("CARGO_PKG_VERSION"))),
        )?;
        if initialized.agent_capabilities.session_capabilities.list.is_none() {
            return Err(format!("{} cannot list sessions", self.command.display()).into());
        }
        let listed: ListSessionsResponse =
            connection.call("session/list", ListSessionsRequest::new().cwd(dir.to_owned()))?;
        let mut sessions = listed
            .sessions
            .into_iter()
            .filter(|info| info.cwd == dir)
            .map(|info| {
                let updated_at =
                    info.updated_at.ok_or_else(|| format!("session {} has no updatedAt", info.session_id))?;
                Ok(Session {
                    id: SessionId(info.session_id.to_string()),
                    title: info.title,
                    last_active: TimestampMs::from(humantime::parse_rfc3339(&updated_at)?),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_active));
        Ok(sessions)
    }
}

impl Connection {
    fn open(command: &Path) -> Result<Self> {
        let mut child = Command::new(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", command.display()))?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout was piped")).lines();
        Ok(Self { child, stdin, stdout, next_id: 1 })
    }

    /// Send one request and wait for its response. Notifications the agent sends meanwhile are
    /// dropped; nothing here subscribes to them.
    fn call<P: Serialize, R: DeserializeOwned>(&mut self, method: &str, params: P) -> Result<R> {
        let id = self.next_id;
        self.next_id += 1;
        let request = JsonRpcMessage::wrap(Request { id: id.into(), method: method.into(), params: Some(params) });
        serde_json::to_writer(&mut self.stdin, &request)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        for line in &mut self.stdout {
            let line = line?;
            let Ok(response) = serde_json::from_str::<
                JsonRpcMessage<Response<serde_json::Value, agent_client_protocol_schema::v1::Error>>,
            >(&line) else {
                continue;
            };
            return match response.into_inner() {
                Response::Result { result, .. } => Ok(serde_json::from_value(result)?),
                Response::Error { error, .. } => Err(format!("{method}: {error}").into()),
            };
        }
        Err(format!("agent exited before answering {method}").into())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Closing stdin asks the agent to exit; kill covers agents that ignore that.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
