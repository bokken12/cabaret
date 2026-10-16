import fs from "node:fs";
import path from "node:path";

export type Post = {
  slug: string;
  title: string;
  chapter: number;
  subsection: number;
  number: string;
  content: string;
};
export type Chapter = { page: Post; children: Post[] };
const directory = path.join(process.cwd(), "posts");

export function getPosts(): Post[] {
  const posts = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const slug = file.slice(0, -3);
      let content = fs.readFileSync(path.join(directory, file), "utf8").replace(/\r\n/g, "\n");
      if (slug === "quickstart") {
        // Quickstart retains its introductory metadata and separate step layout.
        const frontmatter = content.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
        if (frontmatter) content = content.slice(frontmatter[0].length);
        return { slug, title: "Your first review", chapter: 0, subsection: 0, number: "", content };
      }
      const match = slug.match(/^ch(\d+)-(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/);
      if (!match) throw new Error(`${file}: use ch01-00-chapter.md or ch01-01-section.md.`);
      const chapter = Number(match[1]);
      const subsection = Number(match[2]);
      if (!Number.isSafeInteger(chapter) || chapter < 1 || !Number.isSafeInteger(subsection))
        throw new Error(`${file}: invalid chapter number.`);
      const heading = content.match(/^\s*# ([^\n]+)(?:\n|$)/);
      if (!heading) throw new Error(`${file}: begin with a # Page title heading.`);
      const title = heading[1].trim();
      content = content.slice(heading[0].length);
      return {
        slug,
        title,
        chapter,
        subsection,
        number: subsection === 0 ? `${chapter}` : `${chapter}.${subsection}`,
        content,
      };
    })
    .sort((a, b) => a.chapter - b.chapter || a.subsection - b.subsection);
  const numbers = new Set<string>();
  for (const post of posts.filter((post) => post.slug !== "quickstart")) {
    if (numbers.has(post.number)) throw new Error(`Duplicate chapter or section number: ${post.number}`);
    numbers.add(post.number);
    if (post.subsection > 0 && !posts.some((parent) => parent.chapter === post.chapter && parent.subsection === 0)) {
      throw new Error(`${post.slug}: missing ch${String(post.chapter).padStart(2, "0")}-00 chapter page.`);
    }
  }
  return posts;
}

export function getDocumentation() {
  return getPosts().filter((post) => post.slug !== "quickstart");
}

export function getChapters(): Chapter[] {
  const posts = getDocumentation();
  return posts
    .filter((post) => post.subsection === 0)
    .map((page) => ({
      page,
      children: posts.filter((post) => post.chapter === page.chapter && post.subsection > 0),
    }));
}

// Only headings outside code fences start a Quickstart step.
export function getSteps(content: string) {
  const steps: { id: string; title: string; content: string }[] = [];
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    }
    const heading = !fence && line.match(/^## (.+)$/);
    if (heading) {
      const title = heading[1].trim();
      const base = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      let id = base;
      for (let suffix = 2; steps.some((step) => step.id === id); suffix++) id = `${base}-${suffix}`;
      steps.push({ id, title, content: "" });
    } else if (steps.length) steps[steps.length - 1].content += `${line}\n`;
    else if (line.trim()) throw new Error("Quickstart content must begin with a level-two heading.");
  }
  return steps;
}
