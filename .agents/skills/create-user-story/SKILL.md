---
name: create-user-story
description: Manual skill to create user stories in the user-stories/pending/ directory following project format (As a / I want / so that, context, acceptance criteria, optional notes). Invoke explicitly with `/create-user-story` to generate a new story from a rough idea. When the work touches supabase/, splits the story into a paired backend + frontend file. New stories land in user-stories/pending/ (the orchestrator moves them → in-progress → done).
compatibility: 
  - Bash
disable-model-invocation: true
---

## Overview

Use this skill when you need help creating a structured user story. Provide your initial idea — even if it's rough or incomplete — and the skill will ask clarifying questions to help you flesh it out into a complete story ready for `/ticket-orchestrator`.

## How it works

**Input:** A description of a feature, behavior, or capability you want to build (can be vague)

**Process:**
1. Grill the user (via the `grilling` skill at `.agents/skills/grilling/SKILL.md`) to understand the user persona, their goal, the benefit, and relevant context — ask one question at a time, provide a recommended answer per question, and look up facts in the environment rather than asking
2. Gather acceptance criteria (what success looks like, observable outcomes)
3. Optionally collect details like analytics events, feature flags, or design notes if relevant
4. Determine whether the work touches `supabase/` (new/changed tables, columns, RLS policies, edge functions). If it doesn't, generate a single story as before. If it does, split into two independent stories (see "Backend/frontend split" below)
5. Generate the properly-formatted markdown file(s) (only after the grilling reaches a shared understanding you both confirm)

**Output:** Either:
- A single file `user-stories/pending/<derived-name>.md`, or
- A paired split: `user-stories/pending/<derived-name>-backend.md` + `user-stories/pending/<derived-name>-frontend.md`

with confirmation of the file path(s).

## Backend/frontend split

**Boundary:** "Backend" means `supabase/` only — migrations, RLS policies, edge functions. Everything else is "frontend", including `@helsoft/supabase-services` (DAOs/services), `@helsoft/services`, `@helsoft/hooks`, `@helsoft/components`, and `apps/app-study-buddy`.

**When to split:** Only when the grilling surfaces real `supabase/` work (a new/changed table, column, RLS policy, or edge function). If the story is satisfied entirely by existing schema, don't split — emit the single frontend-shaped file as before. Don't force a backend file just to have one.

**Independence:** Each file is a fully independent, self-contained story — its own title, persona framing, Context, and Acceptance Criteria. Don't make one reference or depend on the other being read first.

- **Backend file** (`<derived-name>-backend.md`): framed around a developer/system persona, not the end user, since a migration or RLS policy has no end-user-visible behavior of its own. Example: `**As a** the app's data layer` / `**I want** a \`lessons\` table with RLS scoped to the owning user` / `**so that** frontend code can persist and query lessons securely.` Acceptance criteria describe the schema/contract: tables/columns, constraints, RLS policies and what they allow/deny, edge function inputs/outputs — not UI behavior.
- **Frontend file** (`<derived-name>-frontend.md`): keeps the original end-user persona and framing. Acceptance criteria describe user-visible behavior (what the user can do/see), same as a non-split story. It may assume the backend contract described in the paired file exists — DAOs/services/hooks/components consuming it are frontend work per the boundary above.

Use the same `<derived-name>` prefix for both files so they're recognizable as a pair.

## Story format

Each generated file (single or split) follows this structure:

```markdown
# [Title]

**As a** [user type / persona, or developer/system persona for a backend file]
**I want** [goal / action / capability]
**so that** [benefit / outcome / value]

## Context
[Background, constraints, related features, data sources, why this matters]

## Acceptance criteria
- [Observable outcome or success condition]
- [What the user can do or see when it works — or, for a backend file, the schema/contract guarantee]
- [Given/When/Then style is helpful but not required; use natural language]

## Notes
[Optional: analytics event name, feature flag, design screenshot, related tickets, etc.]
```

## Example interactions

**User says:** "Users need to be able to search for lessons"

**Skill clarifies:**
- Who uses this? (students, teachers, both?)
- What are they searching by? (topic, date, difficulty, keyword?)
- Why do they need this? (they have too many lessons, faster discovery, etc.)
- When would they search? (in the lesson list screen, or from the home screen?)
- What counts as success? (see search results, can filter by type, etc.?)
- Any analytics or flags to track? (optional)
- Does search need new schema/indexes/RLS in `supabase/`, or can it query the existing `lessons` table as-is?

**Result (no schema changes needed):** A single file `user-stories/pending/lesson-search.md`, same as before.

**User says:** "Students need to be able to favorite lessons so they can find them again later"

**Skill clarifies:** same persona/goal/value/context/success questions, and discovers this needs a new `favorites` table with RLS scoped to the student.

**Result (schema changes needed):** Two files:
- `user-stories/pending/lesson-favorites-backend.md` — persona "the app's data layer", AC about the `favorites` table shape and its RLS policy
- `user-stories/pending/lesson-favorites-frontend.md` — persona "student", AC about tapping a favorite icon and seeing favorited lessons in a list

## Running the skill

When you're ready, just describe your feature idea. The more details you have, the better — but don't worry if it's rough. The skill will then apply the `grilling` skill (`.agents/skills/grilling/SKILL.md`) — interviewing you relentlessly, one question at a time with a recommended answer each, until you reach a shared understanding — to clarify:

- **Who** is the user? (the persona or type of person using this)
- **What** do they want to do? (the action, goal, or capability)
- **Why** do they want it? (the value, benefit, or problem it solves)
- **When/Where** would they use this? (context, screens, workflows)
- **Success criteria:** What does "done" look like? (observable, testable outcomes)
- **Schema impact:** Does this need new/changed tables, columns, RLS policies, or edge functions in `supabase/`? (determines whether the story gets split)
- **Optional details:** Analytics events, feature flags, design references, or related context

Once you confirm the grilling has reached a shared understanding, the skill generates your user story file(s) and saves them to the correct location — a single file, or a `-backend.md` / `-frontend.md` pair per the split rules above.
