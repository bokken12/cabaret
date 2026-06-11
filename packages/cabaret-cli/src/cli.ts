#!/usr/bin/env node
import { GitBackend } from "cabaret-node";

const backend = await GitBackend.open(process.cwd());
console.log(await backend.resolve("HEAD"));
