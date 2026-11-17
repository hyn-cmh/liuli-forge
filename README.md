# liuli-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hyn-cmh/liuli-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hyn-cmh/liuli-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node process: git smart HTTP (protocol v0 and v2 — clone, fetch, shallow deepen, push with report-status) over a content-addressed object store, the REST v3 API (repositories, branches, commits, contents, labels, issues, comments, pull requests and squash/merge merges), the GraphQL v4 API (viewer, repository, issues and pull-request connections with cursor pagination, mutations, Relay node ids, introspection) and an MCP endpoint (server/discover and the legacy initialize handshake, six repository tools). One in-memory store backs every surface, timestamps come from a logical clock, and a built pack is a pure function of its object set, so every answer is deterministic.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1pk8yq3w&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
