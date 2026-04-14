export const VIEWER_QUERY = `query Viewer { viewer { id } }`;

export const ISSUE_INFO_QUERY = `
  query IssueInfo($id: String!) {
    issue(id: $id) {
      id
      state { type }
      team { id }
      delegate { id name }
    }
  }
`;

export const TEAM_STARTED_QUERY = `
  query TeamStartedStates($id: String!) {
    team(id: $id) {
      states(filter: { type: { eq: "started" } }) {
        nodes { id position }
      }
    }
  }
`;

export const TEAM_COMPLETED_QUERY = `
  query TeamCompletedStates($id: String!) {
    team(id: $id) {
      states(filter: { type: { eq: "completed" } }) {
        nodes { id position }
      }
    }
  }
`;

export const COMMENT_SESSION_QUERY = `
  query CommentSession($id: String!) {
    comment(id: $id) {
      id
      parentId
      agentSession { id }
      agentSessions(first: 3) {
        nodes { id }
      }
      parent {
        id
        parentId
        agentSession { id }
        agentSessions(first: 3) {
          nodes { id }
        }
      }
    }
  }
`;

export const ISSUE_SESSION_QUERY = `
  query IssueSession($id: String!) {
    issue(id: $id) {
      comments(first: 25) {
        nodes {
          id
          parentId
          agentSession { id }
          agentSessions(first: 3) {
            nodes { id }
          }
        }
      }
    }
  }
`;

export const AGENT_SESSION_ACTIVITIES_QUERY = `
  query AgentSessionActivities($id: String!) {
    agentSession(id: $id) {
      id
      activities {
        edges {
          node {
            id
            updatedAt
            content {
              __typename
              ... on AgentActivityThoughtContent {
                body
              }
              ... on AgentActivityActionContent {
                action
                parameter
                result
              }
              ... on AgentActivityElicitationContent {
                body
              }
              ... on AgentActivityResponseContent {
                body
              }
              ... on AgentActivityErrorContent {
                body
              }
              ... on AgentActivityPromptContent {
                body
              }
            }
          }
        }
      }
    }
  }
`;

export const AGENT_SESSION_RECONCILE_QUERY = `
  query AgentSessionReconcile($id: String!, $first: Int!) {
    agentSession(id: $id) {
      id
      status
      issue {
        id
        identifier
        title
        description
        url
        team { id key }
        project { id key }
      }
      comment {
        id
        body
        parentId
      }
      sourceComment {
        id
        body
        parentId
      }
      activities(first: $first, orderBy: createdAt) {
        nodes {
          id
          createdAt
          updatedAt
          content {
            __typename
            ... on AgentActivityThoughtContent {
              body
            }
            ... on AgentActivityActionContent {
              action
              parameter
              result
            }
            ... on AgentActivityElicitationContent {
              body
            }
            ... on AgentActivityResponseContent {
              body
            }
            ... on AgentActivityErrorContent {
              body
            }
            ... on AgentActivityPromptContent {
              body
            }
          }
        }
      }
    }
  }
`;
