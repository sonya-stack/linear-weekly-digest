import fetch from "node-fetch";
import nodemailer from "nodemailer";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// === 1) Pull issues from Linear (GraphQL) ===
// Docs: https://api.linear.app/graphql (bearer auth), cursor pagination
const linearQuery = `
query Issues($after: String) {
  issues(first: 200, after: $after, filter: { archived: { eq: false } }) {
    nodes {
      id
      identifier
      title
      url
      createdAt
      updatedAt
      dueDate
      completedAt
      state { name type }
      assignee { name }
      project { name }
      team { name }
      priority
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

async function fetchAllIssues() {
  let all = [], after = null;
  while (true) {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": LINEAR_API_KEY
      },
      body: JSON.stringify({ query: linearQuery, variables: { after } })
    });
    const { data } = await res.json();
    all.push(...data.issues.nodes);
    const { hasNextPage, endCursor } = data.issues.pageInfo;
    if (!hasNextPage) break;
    after = endCursor;
  }
  return all;
}

// === 2) Compute weekly stats ===
function computeStats(issues) {
  const now = new Date();
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);

  const open = issues.filter(i => !i.completedAt);
  const overdue = open.filter(i => i.dueDate && new Date(i.dueDate) < now);

  const completedThisWeek = issues.filter(i => i.completedAt && new Date(i.completedAt) >= weekAgo);

  // group by assignee
  const byAssignee = {};
  for (const i of open) {
    const who = i.assignee?.name || "Unassigned";
    byAssignee[who] ??= { open: 0, overdue: 0 };
    byAssignee[who].open += 1;
    if (i.dueDate && new Date(i.dueDate) < now) byAssignee[who].overdue += 1;
  }

  // group by project
  const byProject = {};
  for (const i of open) {
    const proj = i.project?.name || "No project";
    byProject[proj] ??= 0;
    byProject[proj] += 1;
  }

  return { openCount: open.length, overdueCount: overdue.length, completedThisWeek, byAssignee, byProject, overdue, open };
}

// === 3) Format for Discord (embeds) ===
function formatDiscord(stats) {
  const lines = [];
  lines.push(`**Open:** ${stats.openCount} • **Overdue:** ${stats.overdueCount}`);
  lines.push("");
  lines.push(`**By assignee**`);
  for (const [name, v] of Object.entries(stats.byAssignee).sort()) {
    lines.push(`• ${name}: ${v.open} open (${v.overdue} overdue)`);
  }
  lines.push("");
  lines.push(`**By project**`);
  for (const [name, count] of Object.entries(stats.byProject).sort((a,b)=>b[1]-a[1])) {
    lines.push(`• ${name}: ${count}`);
  }
  lines.push("");
  const topOverdue = stats.overdue.slice(0, 10).map(i => `• [${i.identifier}](${i.url}) ${i.title}`);
  if (topOverdue.length) {
    lines.push(`**Top overdue**`);
    lines.push(...topOverdue);
  }
  return { content: null, embeds: [{ title: "📊 Linear Friday Digest", description: lines.join("\n") }] };
}

async function postDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// === 4) Optional: send email via Nodemailer ===
async function sendEmail(html) {
  if (!process.env.SMTP_HOST) return; // skip if not configured
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.MAIL_TO || process.env.SMTP_USER,
    subject: "Linear Friday Digest",
    html
  });
}

function htmlEmail(stats) {
  const li = arr => arr.map(x => `<li>${x}</li>`).join("");
  const assigneeList = Object.entries(stats.byAssignee)
    .map(([n, v]) => `${n}: ${v.open} open (${v.overdue} overdue)`);
  const projectList = Object.entries(stats.byProject)
    .sort((a,b)=>b[1]-a[1]).map(([n,c])=>`${n}: ${c}`);
  const overdueList = stats.overdue.slice(0, 15).map(i => `[${i.identifier}] ${i.title}`);

  return `
    <h2>📊 Linear Friday Digest</h2>
    <p><b>Open:</b> ${stats.openCount} &nbsp; <b>Overdue:</b> ${stats.overdueCount}</p>
    <h3>By assignee</h3><ul>${li(assigneeList)}</ul>
    <h3>By project</h3><ul>${li(projectList)}</ul>
    <h3>Top overdue</h3><ul>${li(overdueList)}</ul>
  `;
}

(async () => {
  const issues = await fetchAllIssues();
  const stats = computeStats(issues);
  await postDiscord(formatDiscord(stats));
  await sendEmail(htmlEmail(stats));
  console.log("Digest sent.");
})();

