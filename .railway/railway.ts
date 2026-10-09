import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const craftSuite = service("craft-suite", {
    source: github("derekcheungsa/craft-suite-railway", { branch: "main", checkSuites: false }),
    replicas: { "us-east4-eqdc4a": 1 },
  });

  // Craft Relay: MCP endpoint + bridge WebSocket for agent control of the
  // suite's browser tabs. Same repo, server/ subdirectory (its own Dockerfile).
  const craftRelay = service("craft-relay", {
    source: github("derekcheungsa/craft-suite-railway", { branch: "main", checkSuites: false }),
    rootDirectory: "server",
    replicas: { "us-east4-eqdc4a": 1 },
  });

  return project("craft-suite", {
    variables: { managed: false },
    resources: [craftSuite, craftRelay],
  });
});
