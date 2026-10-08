import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
};

export default config;
