import { GitHubBackend, githubClient } from "cabaret-github";
import { docText, renderPage } from "cabaret-views";

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN unset");
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  requests++;
  return realFetch(...args);
};
const held = new Map();
const store = { get: (key) => held.get(key), set: (key, value) => void held.set(key, value) };
const repo = { owner: "bokken12", repo: "cabaret" };
const backend = new GitHubBackend(githubClient(token), repo, store);

await backend.configAdd("cabaret.alias", "crouton.ai@gmail.com", "global");
console.log("user:", await backend.currentUser());
const changes = await backend.listChanges();
console.log("changes:", changes.length, changes.slice(0, 8).join(", "));

console.log("requests before home:", requests);
let start = Date.now();
const home = await renderPage(backend, { kind: "home" });
console.log(`cold home: ${requests} requests (${Date.now() - start}ms)`);
console.log(docText(home).split("\n").slice(0, 25).join("\n"));
console.log("errors:", home.errors);

let before = requests;
start = Date.now();
await renderPage(backend, { kind: "home" });
console.log(`warm home: +${requests - before} requests (${Date.now() - start}ms)`);

before = requests;
start = Date.now();
await backend.fetchOrigin();
await renderPage(backend, { kind: "home" });
console.log(`refetch + home: +${requests - before} requests (${Date.now() - start}ms)`);

const [change] = changes;
if (change) {
  before = requests;
  start = Date.now();
  const show = await renderPage(backend, { kind: "show", change });
  console.log(`show ${change}: +${requests - before} requests (${Date.now() - start}ms)`);
  console.log(docText(show).slice(0, 800));
  console.log("errors:", show.errors);
}

// A fresh backend over the same store: what a browser reload costs.
const reloaded = new GitHubBackend(githubClient(token), repo, store);
before = requests;
start = Date.now();
await renderPage(reloaded, { kind: "home" });
console.log(`reload home: +${requests - before} requests (${Date.now() - start}ms), ${held.size} stored objects`);
