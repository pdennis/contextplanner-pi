/**
 * Context Planner Extension for Pi
 *
 * Plan mode + subagent delegation + built-in Exa research, all in one
 * standalone extension. No external packages required.
 *
 * State machine: idle → planning → awaiting_approval → executing → idle
 *
 * During planning, the model can:
 *   - Read files and explore the codebase (read-only enforced by prompt)
 *   - Ask the user clarifying questions
 *   - Use plan_research to spawn a child pi that searches the web via Exa
 *   - Write a plan to a file for user review
 *
 * Exa search is built in — direct REST API calls, no npm dependencies.
 * Requires EXA_API_KEY env var only when plan_research is used.
 */

import { AuthStorage, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text as TUIText } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────────

type PlanPhase = "understanding" | "designing" | "writing" | "researching" | "idle";
type PlanState = "idle" | "planning" | "awaiting_approval" | "executing";

const GOAL_MAX_LENGTH = 300; // characters

// ── Constants ──────────────────────────────────────────────────────────────────

const EXA_PROVIDER = "exa";
const MAX_SUBAGENT_DEPTH = 1;
const EXA_API_BASE = "https://api.exa.ai";

// ── Planning system prompt ─────────────────────────────────────────────────────

const GOAL_INJECTION_PROMPT = `
[SESSION GOAL]
The session goal is stated below. Keep your work aligned with this goal.
If the task scope has drifted from the goal, ask the user (via plan_question if in plan mode, or directly otherwise) whether the goal should be updated.

Goal: {{GOAL}}
`;

const PLANNING_SYSTEM_PROMPT = `[PLAN MODE — READ-ONLY ENFORCED]

You are in planning mode. You MUST NOT edit files, run commands, or make any changes to the system.
This overrides all other instructions. You are strictly read-only.

The only exception: you MAY use plan_research to spawn a research subagent that searches the web.
This is allowed because the subagent runs in an isolated process and only gathers information.

You will work through these phases in order:

1. UNDERSTAND — Read relevant files. If anything is ambiguous, ask the user clarifying questions
   using the plan_question tool. Do NOT proceed until you genuinely understand the task.
   This phase should be unhurried.

   If you need to research something — a library's API, a framework comparison, recent breaking
   changes in a dependency, best practices — use plan_research. This spawns a research subagent
   that can search the web and compile a report for you. Ask the user before researching.

2. DESIGN — Determine the approach. Identify which files will be touched, what the key decisions
   are, and what the risks are. If there are still unknowns, do more research.

3. WRITE PLAN — Write the final plan to the plan file using the plan_write tool.
   The plan should be:
   - Quick to scan
   - Detailed enough to execute from
   - Include paths of files to be modified
   - Commit to ONE approach — do not present alternatives
   - Suggested sections (not rigid):
     • Goal
     • Approach
     • Files to modify
     • Steps (numbered, specific)
     • Verification — include concrete steps the model can run after building to check things work
       (e.g. run the dev server and curl an endpoint, run the test suite, check the build compiles,
       validate output with a quick script). This doesn't need to be full e2e coverage — just enough
       to catch obvious breakage. If verification fails, the model should go back and fix issues.
     • Open questions (if any remain)

   Remember: the user may edit this plan file before approval. Write it clearly.

After writing the plan, use the plan_submit tool to signal you are done.
Do NOT use plan_submit until the plan file is written.

## Goal Alignment

If a session goal has been set, keep the plan aligned with it.
If during planning you detect that the task scope has shifted away from the session goal,
ask the user (via plan_question): "The session goal is X, but the task seems to focus on Y. Should we update the goal?"
Do this proactively — don't wait for the user to notice.`;

// ── Exa API client (from joemccann/pi-exa, adapted) ────────────────────────────

interface ExaResult {
  title: string;
  url: string;
  id: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaSearchResponse {
  requestId: string;
  results: ExaResult[];
  autopromptString?: string;
}

// AuthStorage-backed API key (checks stored key first, then env var)
const authStorage = AuthStorage.create();

function getExaApiKey(): string {
  const cred = authStorage.get(EXA_PROVIDER);
  if (cred?.type === "api_key" && cred.key) return cred.key;
  const envKey = process.env.EXA_API_KEY;
  if (envKey) return envKey;
  throw new Error(
    "Exa API key not configured. Run /exa-login or set EXA_API_KEY. " +
    "Get a key at https://dashboard.exa.ai/api-keys",
  );
}

function hasExaApiKey(): boolean {
  const cred = authStorage.get(EXA_PROVIDER);
  if (cred?.type === "api_key" && cred.key) return true;
  return Boolean(process.env.EXA_API_KEY);
}

async function exaFetch<T = ExaSearchResponse>(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = getExaApiKey();

  const res = await fetch(`${EXA_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa API error (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}

function formatExaResults(results: ExaResult[], autoprompt?: string): string {
  if (!results || results.length === 0) return "No results found.";

  const lines: string[] = [];
  if (autoprompt) {
    lines.push(`Autoprompt: ${autoprompt}`, "");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`[${i + 1}] ${r.title || "(no title)"}`);
    lines.push(`    URL: ${r.url}`);
    if (r.publishedDate) lines.push(`    Published: ${r.publishedDate}`);
    if (r.author) lines.push(`    Author: ${r.author}`);
    if (r.score !== undefined) lines.push(`    Score: ${r.score.toFixed(4)}`);
    if (r.summary) lines.push(`    Summary: ${r.summary}`);
    if (r.highlights?.length) {
      lines.push("    Highlights:");
      for (const h of r.highlights) lines.push(`      · ${h}`);
    }
    if (r.text) {
      const maxLen = 3000;
      lines.push(`    Text: ${r.text.length > maxLen ? r.text.slice(0, maxLen) + "…" : r.text}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Subagent spawn helper ──────────────────────────────────────────────────────

function getSubagentDepth(): number {
  return parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
}

function tempReportPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-research-"));
  return join(dir, "report.md");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function firstSentence(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 197) + "...";
}

interface ChildResult {
  exitCode: number;
  stderr: string;
  outputPath: string;
}

async function spawnChildPi(
  task: string,
  context: string,
  outputPath: string,
  cwd: string,
  tools: string | undefined,
  signal?: AbortSignal,
): Promise<ChildResult> {
  const systemAppend = [
    "You are a subagent. You have a single task to complete.",
    "Do NOT spawn further subagents (do not use the subagent or plan_research tools).",
    `Write your full output to the file at: ${outputPath}`,
    "After writing the file, output a one-sentence summary of what you did.",
  ].join("\n");

  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemAppend];
  if (tools) args.push("--tools", tools);
  args.push(context ? `Context:\n${context}\n\nTask:\n${task}` : task);

  return new Promise<ChildResult>((resolve) => {
    const execBasename = basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execBasename);
    const command = isGenericRuntime ? "pi" : process.execPath;
    const finalArgs = isGenericRuntime ? args : [process.argv[1], ...args];

    const proc = spawn(command, finalArgs, {
      cwd,
      env: { ...process.env, PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.resume();

    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stderr, outputPath });
    };

    proc.on("close", finish);
    proc.on("error", () => finish(1));

    if (signal) {
      if (signal.aborted) { proc.kill("SIGTERM"); finish(1); }
      else signal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      }, { once: true });
    }
  });
}

// ── Default plan file path ─────────────────────────────────────────────────────

function defaultPlanPath(cwd: string): string {
  return resolve(cwd, ".pi", "plan.md");
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function contextPlannerExtension(pi: ExtensionAPI): void {
  let state: PlanState = "idle";
  let phase: PlanPhase = "idle";
  let planFilePath = "";
  let planningStartTime = 0;
  let activeResearchCount = 0;
  let exaAvailable = false;
  let sessionGoal = "";
  let goalSet = false; // tracks whether goal was set this session

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function persistGoal(): void {
    pi.appendEntry("ctxplanner-goal", { goal: sessionGoal, timestamp: Date.now() });
  }

  function updateGoalWidget(ctx: ExtensionContext): void {
    if (sessionGoal) {
      const truncated = sessionGoal.length > GOAL_MAX_LENGTH
        ? sessionGoal.slice(0, GOAL_MAX_LENGTH - 3) + "..."
        : sessionGoal;
      ctx.ui.setWidget("ctxplanner-goal", [
        ctx.ui.theme.fg("accent", `🎯 Goal: `) + truncated,
      ]);
    } else {
      ctx.ui.setWidget("ctxplanner-goal", undefined);
    }
  }

  function updateUI(ctx: ExtensionContext): void {
    updateGoalWidget(ctx);
    if (state === "planning") {
      const elapsed = Math.round((Date.now() - planningStartTime) / 1000);
      const label =
        phase === "researching" ? `Researching (${activeResearchCount} active)` :
        phase === "understanding" ? "Understanding" :
        phase === "designing" ? "Designing" :
        "Writing plan";
      ctx.ui.setStatus("ctxplanner", ctx.ui.theme.fg("accent", `⏳ Planning... ${label} (${elapsed}s)`));

      const phaseLabel =
        phase === "researching" ? "Phase 1/3: Understanding + Research" :
        phase === "understanding" ? "Phase 1/3: Understanding" :
        phase === "designing" ? "Phase 2/3: Designing" :
        "Phase 3/3: Writing plan";

      ctx.ui.setWidget("ctxplanner-phase", [
        ctx.ui.theme.fg("accent", `⏳ ${phaseLabel}`),
        ctx.ui.theme.fg("dim", `Plan file: ${planFilePath}`),
      ]);
    } else if (state === "awaiting_approval") {
      ctx.ui.setStatus("ctxplanner", ctx.ui.theme.fg("warning", "📋 Awaiting plan approval"));
      ctx.ui.setWidget("ctxplanner-phase", [
        ctx.ui.theme.fg("warning", "📋 Plan ready — awaiting your approval"),
        ctx.ui.theme.fg("dim", `Plan file: ${planFilePath}`),
      ]);
    } else if (state === "executing") {
      ctx.ui.setStatus("ctxplanner", ctx.ui.theme.fg("success", "▶ Executing plan"));
      ctx.ui.setWidget("ctxplanner-phase", undefined);
    } else {
      ctx.ui.setStatus("ctxplanner", undefined);
      ctx.ui.setWidget("ctxplanner-phase", undefined);
    }
  }

  function clearState(): void {
    state = "idle";
    phase = "idle";
    planningStartTime = 0;
    activeResearchCount = 0;
  }

  function persistState(): void {
    pi.appendEntry("ctxplanner-state", { state, phase, planFilePath, timestamp: Date.now() });
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Enter plan mode: understand, research, design, write a plan, then execute on approval",
    handler: async (_args, ctx) => {
      if (state === "planning" || state === "awaiting_approval") {
        ctx.ui.notify("Already in plan mode. Use /plan-cancel to exit.", "warning");
        return;
      }

      planFilePath = defaultPlanPath(ctx.cwd);
      mkdirSync(dirname(planFilePath), { recursive: true });
      writeFileSync(planFilePath, "# Plan\n\n*(Thinking...)*\n", "utf8");

      state = "planning";
      phase = "understanding";
      planningStartTime = Date.now();
      activeResearchCount = 0;

      updateUI(ctx);
      persistState();

      // Ask the user for their planning prompt BEFORE triggering a model turn
      const prompt = await ctx.ui.input(
        "Plan mode",
        "What do you want to plan? Describe the task you'd like me to investigate and design a plan for.",
      );

      if (!prompt?.trim()) {
        // User cancelled or gave empty input — exit plan mode cleanly
        clearState();
        updateUI(ctx);
        persistState();
        ctx.ui.notify("Plan mode cancelled — no prompt provided.", "info");
        return;
      }

      ctx.ui.notify(`Plan mode activated. Plan file: ${planFilePath}`, "info");

      pi.sendUserMessage(
        "I want to plan this task carefully. Please enter planning mode: understand the task, " +
        "research anything unclear, then design an approach, then write the plan to the plan file.\n\n" +
        `Here is the task I want to plan:\n\n${prompt.trim()}`,
      );
    },
  });

  // ── Exa key management ─────────────────────────────────────────────────

  pi.registerCommand("exa-login", {
    description: "Set your Exa API key",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Run /exa-login in interactive mode.", "info");
        return;
      }
      const key = await ctx.ui.input("Exa API Key", "Paste your Exa API key");
      if (key?.trim()) {
        authStorage.set(EXA_PROVIDER, { type: "api_key", key: key.trim() });
        exaAvailable = true;
        ctx.ui.notify("Exa API key saved. Web research is now available.", "info");
      } else {
        ctx.ui.notify("No key provided.", "warning");
      }
    },
  });

  pi.registerCommand("exa-logout", {
    description: "Remove your stored Exa API key",
    handler: async (_args, ctx) => {
      authStorage.remove(EXA_PROVIDER);
      exaAvailable = hasExaApiKey();
      ctx.ui.notify(
        process.env.EXA_API_KEY
          ? "Stored key removed. EXA_API_KEY env var is still set."
          : "Exa API key removed. Run /exa-login to set a new one.",
        "info",
      );
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel plan mode and return to idle",
    handler: async (_args, ctx) => {
      if (state === "idle") {
        ctx.ui.notify("Not in plan mode.", "info");
        return;
      }
      if (existsSync(planFilePath) && state !== "executing") {
        try { writeFileSync(planFilePath, "# Plan (cancelled)\n", "utf8"); } catch {}
      }
      clearState();
      updateUI(ctx);
      persistState();
      ctx.ui.notify("Plan mode cancelled.", "info");
    },
  });

  // ── Plan mode toggle shortcut ──────────────────────────────────────────────

  pi.registerShortcut("ctrl+b", {
    description: "Toggle plan mode: enter when idle, exit/execute when planning",
    handler: async (ctx) => {
      // ── Exit path: already in plan mode ─────────────────────────────────
      if (state === "planning" || state === "awaiting_approval") {
        // Abort the current agent turn so the model stops generating
        if (!ctx.isIdle()) ctx.abort();

        // Check if the plan file has real content (not just the placeholder)
        let planFileReady = false;
        try {
          const raw = readFileSync(planFilePath, "utf8");
          planFileReady = !raw.includes("*(Thinking...)*") && raw.trim().length > 20;
        } catch { /* file doesn't exist yet — execution options will be hidden */ }

        const items: string[] = [];
        if (planFileReady) {
          items.push("✅  Execute plan — approve and start executing now");
          items.push("🔄  Clear context & execute — exit, filter context, send clean execute message");
        }
        items.push("🚪  Exit without executing — cancel plan mode, return to idle");
        items.push("✖  Cancel — stay in plan mode");

        const choice = await ctx.ui.select("Exit plan mode", items);

        if (!choice || choice.startsWith("✖")) return;

        if (choice.startsWith("✅")) {
          await handleApproval(ctx);
        } else if (choice.startsWith("🔄")) {
          clearState();
          updateUI(ctx);
          persistState();
          pi.sendUserMessage(
            `Read the plan from \`${planFilePath}\` and execute it step by step.`,
          );
        } else if (choice.startsWith("🚪")) {
          if (existsSync(planFilePath)) {
            try { writeFileSync(planFilePath, "# Plan (cancelled)\n", "utf8"); } catch {}
          }
          clearState();
          updateUI(ctx);
          persistState();
          ctx.ui.notify("Plan mode exited.", "info");
        }
        return;
      }

      // ── Enter path: not in plan mode ────────────────────────────────────
      if (state !== "idle") return; // silent no-op during execution

      planFilePath = defaultPlanPath(ctx.cwd);
      mkdirSync(dirname(planFilePath), { recursive: true });
      writeFileSync(planFilePath, "# Plan\n\n*(Thinking...)*\n", "utf8");

      state = "planning";
      phase = "understanding";
      planningStartTime = Date.now();
      activeResearchCount = 0;

      updateUI(ctx);
      persistState();

      const prompt = await ctx.ui.input(
        "Plan mode",
        "What do you want to plan? Describe the task you'd like me to investigate and design a plan for.",
      );

      if (!prompt?.trim()) {
        clearState();
        updateUI(ctx);
        persistState();
        ctx.ui.notify("Plan mode cancelled — no prompt provided.", "info");
        return;
      }

      ctx.ui.notify(`Plan mode activated. Plan file: ${planFilePath}`, "info");

      pi.sendUserMessage(
        "I want to plan this task carefully. Please enter planning mode: understand the task, " +
        "research anything unclear, then design an approach, then write the plan to the plan file.\n\n" +
        `Here is the task I want to plan:\n\n${prompt.trim()}`,
      );
    },
  });

  // ── Goal command ────────────────────────────────────────────────────────────

  pi.registerCommand("goal", {
    description: "View or edit the session goal",
    handler: async (_args, ctx) => {
      const newGoal = await ctx.ui.input("Session Goal", "Set a 1-3 sentence intention for this session", sessionGoal);
      if (newGoal !== undefined) {
        sessionGoal = newGoal.trim();
        goalSet = true;
        persistGoal();
        updateGoalWidget(ctx);
        if (sessionGoal) {
          ctx.ui.notify(`Goal updated.`, "info");
        } else {
          ctx.ui.notify("Goal cleared.", "info");
        }
      }
    },
  });

  // ── Plan tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "plan_set_goal",
    label: "Set Session Goal",
    description: [
      "Set or update the session goal — a 1-3 sentence intention for the session.",
      "Call this early in the session based on the user's initial prompt.",
      "The goal is shown persistently in the UI and kept in context to guide all work.",
      "If the task scope shifts, call this again to update the goal.",
    ].join(" "),
    promptSnippet: "Set the session goal/intention",
    promptGuidelines: [
      "Use plan_set_goal early in a session to articulate a 1-3 sentence goal based on the user's request.",
      "If the conversation scope shifts significantly, use plan_set_goal to update the goal and keep it aligned.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "1-3 sentence goal/intention for the session" }),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      sessionGoal = params.goal.trim();
      goalSet = true;
      persistGoal();
      updateGoalWidget(ctx);
      return { content: [{ type: "text", text: `Session goal set: ${sessionGoal}` }] };
    },
  });

  pi.registerTool({
    name: "plan_question",
    label: "Plan Question",
    description: "Ask the user a clarifying question during planning.",
    promptSnippet: "Ask the user a clarifying question during planning",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      if (state !== "planning") {
        return { content: [{ type: "text", text: "Not in planning mode." }] };
      }
      const answer = await ctx.ui.input("Planning question:", params.question);
      return { content: [{ type: "text", text: answer ?? "(no answer provided)" }] };
    },
  });

  pi.registerTool({
    name: "plan_set_phase",
    label: "Plan Set Phase",
    description: "Update the planning phase indicator: 'understanding', 'designing', or 'writing'.",
    promptSnippet: "Update planning phase indicator",
    parameters: Type.Object({
      phase: Type.String({ description: "Phase: 'understanding', 'designing', or 'writing'" }),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const valid: PlanPhase[] = ["understanding", "designing", "writing"];
      if (!valid.includes(params.phase as PlanPhase)) {
        return { content: [{ type: "text", text: `Invalid phase. Use: ${valid.join(", ")}` }] };
      }
      phase = params.phase as PlanPhase;
      updateUI(ctx);
      return { content: [{ type: "text", text: `Phase: ${phase}` }] };
    },
  });

  pi.registerTool({
    name: "plan_write",
    label: "Plan Write",
    description: "Write the plan markdown to the plan file for user review.",
    promptSnippet: "Write the plan to the plan file",
    parameters: Type.Object({
      content: Type.String({ description: "Full plan content in markdown" }),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      if (state !== "planning") {
        return { content: [{ type: "text", text: "Not in planning mode." }] };
      }
      if (phase !== "writing") { phase = "writing"; updateUI(ctx); }
      try {
        mkdirSync(dirname(planFilePath), { recursive: true });
        writeFileSync(planFilePath, params.content, "utf8");
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to write plan: ${err}` }] };
      }
      return { content: [{ type: "text", text: `Plan written to ${planFilePath}.` }] };
    },
  });

  pi.registerTool({
    name: "plan_submit",
    label: "Plan Submit",
    description: "Submit the plan for user approval. Call AFTER plan_write.",
    promptSnippet: "Submit the plan for approval",
    parameters: Type.Object({}),
    async execute(_id, _params, _sig, _onUpdate, ctx) {
      if (state !== "planning") {
        return { content: [{ type: "text", text: "Not in planning mode." }] };
      }

      let planContent: string;
      try { planContent = readFileSync(planFilePath, "utf8"); } catch {
        return { content: [{ type: "text", text: `Plan file not found at ${planFilePath}. Use plan_write first.` }] };
      }

      state = "awaiting_approval";
      phase = "idle";
      updateUI(ctx);

      pi.sendMessage({
        customType: "plan-content",
        content: [
          `**Plan ready for review**`,
          ``,
          `File: \`${planFilePath}\``,
          sessionGoal ? `Goal: ${sessionGoal}` : null,
          ``,
          `---`,
          ``,
          planContent,
          ``,
          `---`,
        ].filter(Boolean).join("\n"),
        display: true,
        details: { path: planFilePath, goal: sessionGoal || undefined },
      }, { triggerTurn: false });

      const choice = await ctx.ui.select("Plan submitted. What next?", [
        "✅  Approve — execute the plan",
        "✏️  Edit — I'll edit the plan file first, then approve",
        "❌  Cancel — discard the plan",
      ]);

      if (choice?.startsWith("✅")) {
        return handleApproval(ctx);
      } else if (choice?.startsWith("✏️")) {
        const ok = await ctx.ui.confirm(
          "Plan edit",
          `Edit the plan file at:\n${planFilePath}\n\nConfirm when done.`,
        );
        if (ok) return handleApproval(ctx);
        clearState(); updateUI(ctx); persistState();
        return { content: [{ type: "text", text: "Plan cancelled after editing." }] };
      } else {
        clearState(); updateUI(ctx); persistState();
        return { content: [{ type: "text", text: "Plan cancelled." }] };
      }
    },
  });

  // ── Research tool (spawns child pi with exa tools available) ───────────────

  pi.registerTool({
    name: "plan_research",
    label: "Plan Research",
    description: [
      "Spawn a research subagent to investigate a topic using Exa web search.",
      "Use this during planning when you need information beyond the codebase:",
      "library APIs, framework comparisons, breaking changes, best practices, documentation.",
      "The subagent runs in an isolated child pi process with search tools.",
      "You MUST ask the user for permission before researching.",
    ].join(" "),
    promptSnippet: "Spawn a research subagent to search the web for information",
    promptGuidelines: [
      "Use plan_research during planning when you need external information (library docs, API references, framework comparisons).",
      "Always ask the user's permission before calling plan_research — explain what you want to investigate and why.",
      "plan_research spawns an isolated child pi process with web search tools. It does not modify the project.",
    ],
    parameters: Type.Object({
      topic: Type.String({ description: "What to research, e.g. 'React 19 breaking changes' or 'Fastify vs Express migration'" }),
      questions: Type.String({
        description: "Specific questions to answer, one per line. Be concrete.",
      }),
      context: Type.Optional(Type.String({
        description: "Additional context: relevant code snippets, current setup, why this matters.",
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (state !== "planning") {
        return { content: [{ type: "text", text: "Not in planning mode." }] };
      }

      // Check exa availability
      if (!exaAvailable) {
        return {
          content: [{
            type: "text",
            text: "Exa search is not available. Set the EXA_API_KEY environment variable to enable research.",
          }],
        };
      }

      if (getSubagentDepth() > MAX_SUBAGENT_DEPTH) {
        return { content: [{ type: "text", text: "Cannot spawn research subagent: recursion depth exceeded." }] };
      }

      // Ask user permission
      const permission = await ctx.ui.confirm(
        "Research request",
        `Investigate:\n\n**${params.topic}**\n\nQuestions:\n${params.questions}\n\nThis spawns a child process to search the web. Allow?`,
      );
      if (!permission) {
        return { content: [{ type: "text", text: "User declined the research request." }] };
      }

      phase = "researching";
      activeResearchCount++;
      updateUI(ctx);

      const outputPath = tempReportPath();
      const startedAt = Date.now();
      const statusKey = `research-${startedAt}`;

      const updateStatus = () => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const topic = params.topic.length > 40 ? params.topic.slice(0, 40) + "..." : params.topic;
        ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("muted", `🔍 Researching: ${topic} (${elapsed}s)`));
      };
      updateStatus();
      const interval = setInterval(updateStatus, 2000);

      try {
        onUpdate?.({ content: [{ type: "text", text: `Research subagent spawned for: ${params.topic}` }] });

        const researchSystemPrompt = [
          "You are a research agent. Investigate a topic and write a comprehensive report.",
          "",
          "Available tools:",
          "- exa_search — semantic web search (finds pages by meaning, not keywords)",
          "- exa_find_similar — find pages similar to a given URL",
          "- exa_get_contents — extract clean content from URLs",
          "- read, grep, find, ls — read local files if needed for context",
          "",
          "Instructions:",
          "1. Use exa_search to find relevant information (use type: 'deep' for complex queries)",
          "2. Use exa_get_contents to read full pages when excerpts aren't enough",
          "3. Synthesize your findings into a well-organized report",
          `4. Write the report to: ${outputPath}`,
          "5. Include source URLs where applicable",
          "6. Be factual — distinguish between what you found and what you infer",
          "",
          "After writing the report file, output a one-sentence summary.",
        ].join("\n");

        const taskPrompt = [
          `Research topic: ${params.topic}`,
          "",
          "Questions to answer:",
          params.questions,
          params.context ? `\nAdditional context:\n${params.context}` : "",
          "",
          "Write a thorough, well-organized research report addressing each question.",
          "Include source URLs. Write the report to the output file.",
        ].join("\n");

        // Tools for the research child: exa tools + read-only local tools
        const researchTools = "exa_search,exa_find_similar,exa_get_contents,read,grep,find,ls";

        const result = await spawnChildPi(
          taskPrompt,
          researchSystemPrompt,
          outputPath,
          ctx.cwd,
          researchTools,
          signal,
        );

        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        ctx.ui.setStatus(statusKey, undefined);

        if (result.exitCode !== 0) {
          const errMsg = result.stderr.trim() || `exited with code ${result.exitCode}`;
          return { content: [{ type: "text", text: `Research failed (${elapsed}s): ${errMsg}` }] };
        }

        let report = "";
        try { report = readFileSync(outputPath, "utf8"); } catch {}

        if (!report.trim()) {
          return { content: [{ type: "text", text: `Research completed in ${elapsed}s but produced no report.` }] };
        }

        const summary = firstSentence(report);
        const size = Buffer.byteLength(report, "utf8");

        // Clean up temp file
        try { unlinkSync(outputPath); } catch {}
        try { rmdirSync(dirname(outputPath)); } catch {}

        return {
          content: [{
            type: "text",
            text: [
              `Research completed in ${elapsed}s (${formatBytes(size)}).`,
              `Summary: ${summary}`,
              "",
              "--- REPORT START ---",
              report,
              "--- REPORT END ---",
            ].join("\n"),
          }],
          details: { topic: params.topic, size, elapsed },
        };
      } finally {
        clearInterval(interval);
        activeResearchCount = Math.max(0, activeResearchCount - 1);
        if (state === "planning" && phase === "researching" && activeResearchCount === 0) {
          phase = "understanding";
        }
        updateUI(ctx);
      }
    },
  });

  // ── Built-in Exa tools (registered for research subagent to use) ────────────

  pi.registerTool({
    name: "exa_search",
    label: "Exa Search",
    description:
      "Search the web using Exa's semantic search API. Finds pages by meaning, " +
      "not just keywords. Returns results with optional full text, highlights, " +
      "and AI-generated summaries. Supports domain filtering, date ranges, " +
      "content categories, and multiple search modes including deep reasoning.",
    promptSnippet: "Semantic web search via Exa AI",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (default: 10, max: 100)" })),
      type: Type.Optional(Type.String({
        description: "Search type: auto (default), fast, neural, or deep (multi-step reasoning)",
      })),
      category: Type.Optional(Type.String({
        description: "Filter: company, research paper, news, tweet, personal site, financial report",
      })),
      includeDomains: Type.Optional(Type.Array(Type.String(), {
        description: "Only include results from these domains",
      })),
      excludeDomains: Type.Optional(Type.Array(Type.String(), {
        description: "Exclude results from these domains",
      })),
      startPublishedDate: Type.Optional(Type.String({
        description: "ISO 8601 date — only results published after this",
      })),
      endPublishedDate: Type.Optional(Type.String({
        description: "ISO 8601 date — only results published before this",
      })),
      includeText: Type.Optional(Type.Boolean({ description: "Return full page text (default: false)" })),
      includeSummary: Type.Optional(Type.Boolean({ description: "Return AI summary (default: false)" })),
      includeHighlights: Type.Optional(Type.Boolean({ description: "Return relevant excerpts (default: true)" })),
      maxTextCharacters: Type.Optional(Type.Number({ description: "Max chars per result (default: 3000)" })),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Searching Exa: "${params.query}"…` }] });

      const body: Record<string, unknown> = {
        query: params.query,
        numResults: params.numResults ?? 10,
      };

      if (params.type) body.type = params.type;
      if (params.category) body.category = params.category;
      if (params.includeDomains) body.includeDomains = params.includeDomains;
      if (params.excludeDomains) body.excludeDomains = params.excludeDomains;
      if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
      if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;

      const contents: Record<string, unknown> = {};
      if (params.includeHighlights !== false) contents.highlights = true;
      if (params.includeSummary) contents.summary = true;
      if (params.includeText) contents.text = { maxCharacters: params.maxTextCharacters ?? 3000 };
      if (Object.keys(contents).length > 0) body.contents = contents;

      const response = await exaFetch<ExaSearchResponse>("/search", body, signal);
      const formatted = formatExaResults(response.results, response.autopromptString);

      return {
        content: [{ type: "text", text: formatted }],
        details: { resultCount: response.results.length, requestId: response.requestId },
      };
    },
  });

  pi.registerTool({
    name: "exa_find_similar",
    label: "Exa Find Similar",
    description:
      "Find web pages semantically similar to a given URL. Useful for competitor " +
      "analysis, finding related content, discovering alternatives.",
    promptSnippet: "Find pages similar to a URL via Exa AI",
    parameters: Type.Object({
      url: Type.String({ description: "URL to find similar pages for" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (default: 10)" })),
      includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains" })),
      excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains" })),
      startPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 date — only after" })),
      endPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 date — only before" })),
      includeText: Type.Optional(Type.Boolean({ description: "Return full text (default: false)" })),
      includeSummary: Type.Optional(Type.Boolean({ description: "Return AI summary (default: false)" })),
      includeHighlights: Type.Optional(Type.Boolean({ description: "Return excerpts (default: true)" })),
      excludeText: Type.Optional(Type.String({ description: "Exclude results containing this text" })),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Finding pages similar to: ${params.url}…` }] });

      const body: Record<string, unknown> = { url: params.url, numResults: params.numResults ?? 10 };
      if (params.includeDomains) body.includeDomains = params.includeDomains;
      if (params.excludeDomains) body.excludeDomains = params.excludeDomains;
      if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
      if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
      if (params.excludeText) body.excludeText = params.excludeText;

      const contents: Record<string, unknown> = {};
      if (params.includeHighlights !== false) contents.highlights = true;
      if (params.includeSummary) contents.summary = true;
      if (params.includeText) contents.text = { maxCharacters: 3000 };
      if (Object.keys(contents).length > 0) body.contents = contents;

      const response = await exaFetch<ExaSearchResponse>("/findSimilar", body, signal);
      return {
        content: [{ type: "text", text: formatExaResults(response.results) }],
        details: { resultCount: response.results.length, requestId: response.requestId },
      };
    },
  });

  pi.registerTool({
    name: "exa_get_contents",
    label: "Exa Get Contents",
    description:
      "Extract clean, parsed content from one or more URLs. More reliable than scraping.",
    promptSnippet: "Extract clean page content from URLs via Exa",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to extract content from", minItems: 1 }),
      includeText: Type.Optional(Type.Boolean({ description: "Return full text (default: true)" })),
      includeSummary: Type.Optional(Type.Boolean({ description: "Return AI summary (default: false)" })),
      includeHighlights: Type.Optional(Type.Boolean({ description: "Return excerpts (default: false)" })),
      maxTextCharacters: Type.Optional(Type.Number({ description: "Max chars per page (default: 5000)" })),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Extracting content from ${params.urls.length} URL(s)…` }] });

      const contents: Record<string, unknown> = {};
      if (params.includeText !== false) contents.text = { maxCharacters: params.maxTextCharacters ?? 5000 };
      if (params.includeSummary) contents.summary = true;
      if (params.includeHighlights) contents.highlights = true;

      const body: Record<string, unknown> = { ids: params.urls, contents };

      const response = await exaFetch<ExaSearchResponse>("/contents", body, signal);
      return {
        content: [{ type: "text", text: formatExaResults(response.results) }],
        details: { resultCount: response.results.length, requestId: response.requestId },
      };
    },
  });

  // ── Message renderers ──────────────────────────────────────────────────────

  pi.registerMessageRenderer("plan-content", (message, _options, theme) => {
    const lines: string[] = [];
    lines.push(theme.fg("accent", theme.bold("📋 Plan ready for review")));
    lines.push(theme.fg("dim", `File: ${message.details?.path ?? "unknown"}`));
    if (message.details?.goal) {
      lines.push(theme.fg("accent", `🎯 Goal: `) + String(message.details.goal));
    }
    lines.push("");
    // The content already contains the formatted plan with --- delimiters
    const content = message.content || "";
    for (const line of content.split("\n")) {
      // Skip the header lines we already rendered
      if (line.startsWith("File: ") || line === "**Plan ready for review**" || line.startsWith("Goal: ")) continue;
      lines.push(line);
    }
    return new TUIText(lines.join("\n"), 1, 1, (s: string) => theme.bg("customMessageBg", s));
  });

  // ── General subagent tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a task to a child pi session with a fresh context window.",
      "The child runs independently, writes its full output to a file,",
      "and you receive the file path, size, and a one-sentence summary.",
    ].join(" "),
    promptSnippet: "Delegate a task to an isolated subagent",
    promptGuidelines: [
      "Use subagent when a task would bloat the current context or can run independently.",
      "Before calling subagent, prepare thorough context: relevant code, constraints, prior decisions.",
      "Always read the subagent's output file when you need the full result.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "What the subagent should do" }),
      context: Type.String({ description: "Background, relevant code, constraints. Be generous." }),
      output: Type.Optional(Type.String({ description: "File path for results. Defaults to temp file." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const depth = getSubagentDepth();
      if (depth > MAX_SUBAGENT_DEPTH) {
        throw new Error(`Subagent recursion depth (${depth}) exceeds limit (${MAX_SUBAGENT_DEPTH}).`);
      }

      const outputPath = params.output ?? tempReportPath();
      const startedAt = Date.now();
      const statusKey = `subagent-${startedAt}`;

      const updateStatus = () => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        ctx.ui.setStatus(statusKey, `⏳ subagent running… ${elapsed}s`);
      };
      updateStatus();
      const interval = setInterval(updateStatus, 1000);

      try {
        onUpdate?.({ content: [{ type: "text", text: "Subagent spawned, waiting for completion..." }] });

        const result = await spawnChildPi(params.task, params.context, outputPath, ctx.cwd, undefined, signal);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);

        if (result.exitCode !== 0) {
          ctx.ui.setStatus(statusKey, `✗ subagent failed after ${elapsed}s`);
          const errMsg = result.stderr.trim() || `exited with code ${result.exitCode}`;
          throw new Error(`Subagent failed (${elapsed}s): ${errMsg}`);
        }

        let outputText = "";
        try { outputText = readFileSync(outputPath, "utf8"); } catch {}
        const summary = outputText ? firstSentence(outputText) : "(no output written)";
        let size = 0;
        try { size = statSync(outputPath).size; } catch {}

        ctx.ui.setStatus(statusKey, `✓ subagent done in ${elapsed}s`);

        return {
          content: [{
            type: "text",
            text: [
              `Subagent completed in ${elapsed}s.`,
              `Output: ${outputPath} (${formatBytes(size)})`,
              `Summary: ${summary}`,
            ].join("\n"),
          }],
          details: { outputPath, size, summary, elapsed, exitCode: result.exitCode },
        };
      } finally {
        clearInterval(interval);
        setTimeout(() => ctx.ui.setStatus(statusKey, undefined), 3000);
      }
    },
  });

  // ── Approval handler ───────────────────────────────────────────────────────

  async function handleApproval(ctx: ExtensionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    let planContent: string;
    try { planContent = readFileSync(planFilePath, "utf8"); } catch {
      return { content: [{ type: "text", text: `Failed to read plan file at ${planFilePath}.` }] };
    }

    state = "executing";
    phase = "idle";
    updateUI(ctx);
    persistState();

    pi.sendMessage({
      customType: "plan-execute",
      content: [
        `[PLAN APPROVED — NOW EXECUTING]`,
        `The user approved the plan. Execute it now.`,
        `Read the plan carefully and follow the steps in order.`,
        `Full tool access is restored.`,
        ``,
        `Plan file: ${planFilePath}`,
        ``,
        `--- PLAN START ---`,
        planContent,
        `--- PLAN END ---`,
        ``,
        `Begin execution.`,
      ].join("\n"),
      display: false,
    }, { triggerTurn: true, deliverAs: "steer" });

    return { content: [{ type: "text", text: `Plan approved. Executing from: ${planFilePath}` }] };
  }

  // ── Prompt injection ───────────────────────────────────────────────────────

  pi.on("before_agent_start", async () => {
    // Build goal injection if goal is set
    const goalMessage = sessionGoal
      ? {
          customType: "ctxplanner-goal-context",
          content: GOAL_INJECTION_PROMPT.replace("{{GOAL}}", sessionGoal),
          display: false,
        }
      : undefined;

    if (state === "planning") {
      const planningContent = [
        `[PLAN MODE ACTIVE — Phase: ${phase}]`,
        `Plan file: ${planFilePath}`,
        ``,
        `Start by understanding the task. Read files, use plan_question to ask questions.`,
        `If you need external information (docs, APIs, comparisons), ask the user permission and use plan_research.`,
        `When ready, use plan_set_phase → 'designing', then plan_set_phase → 'writing'.`,
        `Use plan_write to write the plan, then plan_submit to submit for approval.`,
      ];
      if (sessionGoal) {
        planningContent.push(``);
        planningContent.push(`Session goal: ${sessionGoal}`);
        planningContent.push(`Ensure the plan aligns with this goal.`);
      }

      return {
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        message: {
          customType: "ctxplanner-context",
          content: planningContent.join("\n"),
          display: false,
        },
      };
    }

    if (state === "awaiting_approval") {
      return {
        message: {
          customType: "ctxplanner-context",
          content: `[PLAN MODE — Awaiting user approval. Do not act until the user responds.]`,
          display: false,
        },
      };
    }

    // Not in plan mode — inject goal context if set, and prompt for goal on first turn
    const messages: Array<{ customType: string; content: string; display: boolean }> = [];
    if (goalMessage) {
      messages.push(goalMessage);
    } else if (!goalSet) {
      // First turn: ask model to articulate a goal
      goalSet = true; // only prompt once
      messages.push({
        customType: "ctxplanner-goal-prompt",
        content: [
          `[SESSION GOAL REQUEST]`,
          `Based on the user's prompt, articulate a concise 1-3 sentence intention/goal for this session.`,
          `Use the plan_set_goal tool to set it. Be specific and actionable.`,
          `Do NOT ask the user for confirmation — just set it. They can modify it later with /goal.`,
          `If the user's prompt is trivial (e.g. a quick question), set a minimal goal like "Answer the user's question about X".`,
        ].join("\n"),
        display: false,
      });
    }
    if (messages.length > 0) {
      return { message: messages[0] };
    }
  });

  // ── Filter stale context when idle ─────────────────────────────────────────

  pi.on("context", async (event) => {
    if (state === "planning" || state === "awaiting_approval") return;
    return {
      messages: event.messages.filter((m) => {
        const msg = m as { customType?: string };
        return !["ctxplanner-context", "plan-content", "plan-execute"].includes(msg.customType ?? "");
      }),
    };
  });

  // ── Execution lifecycle ────────────────────────────────────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (state === "executing") {
      ctx.ui.notify(
        `Plan execution turn complete. Plan file: ${planFilePath}\nUse /plan-cancel to exit when done.`,
        "info",
      );
    }
  });

  // ── Session startup / state restoration ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Check exa availability
    authStorage.reload(); // pick up changes from other sessions
    exaAvailable = hasExaApiKey();
    if (!exaAvailable && ctx.hasUI) {
      // First-boot prompt: offer to set the key now
      const setup = await ctx.ui.confirm(
        "contextplanner: Exa API key not configured",
        "Web research won't be available without an Exa API key.\n\nSet one now? (Get a key at dashboard.exa.ai/api-keys)",
      );
      if (setup) {
        const key = await ctx.ui.input("Exa API Key", "Paste your Exa API key");
        if (key?.trim()) {
          authStorage.set(EXA_PROVIDER, { type: "api_key", key: key.trim() });
          exaAvailable = true;
          ctx.ui.notify("Exa API key saved. Web research is ready.", "info");
        }
      }
      if (!exaAvailable) {
        ctx.ui.notify(
          "Run /exa-login anytime to add your key, or set EXA_API_KEY env var.",
          "info",
        );
      }
    }

    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter((e: { type: string; customType?: string }) =>
        e.type === "custom" && (e.customType === "ctxplanner-state" || e.customType === "plan-mode-state"),
      )
      .pop() as { data?: { state: PlanState; phase: PlanPhase; planFilePath: string } } | undefined;

    if (stateEntry?.data) {
      state = stateEntry.data.state;
      phase = stateEntry.data.phase;
      planFilePath = stateEntry.data.planFilePath || defaultPlanPath(ctx.cwd);
      if (state === "awaiting_approval") state = "idle"; // dialog lost on restart
    }

    // Restore persisted goal
    const goalEntry = entries
      .filter((e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "ctxplanner-goal",
      )
      .pop() as { data?: { goal: string; timestamp: number } } | undefined;

    if (goalEntry?.data?.goal) {
      sessionGoal = goalEntry.data.goal;
      goalSet = true;
    }

    updateUI(ctx);
  });

  // ── Live status updates ────────────────────────────────────────────────────

  pi.on("turn_start", async (_e, ctx) => { if (state === "planning") updateUI(ctx); });
  pi.on("message_update", async (_e, ctx) => { if (state === "planning") updateUI(ctx); });
  pi.on("tool_execution_end", async (_e, ctx) => { if (state === "planning") updateUI(ctx); });
}
