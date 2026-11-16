"use generative";

import { defineToolkit } from "@assistant-ui/react";
import { z } from "zod";
import { DashboardCard } from "../components/dashboard";
import { dashboardBrief, filterChange } from "./brief";
import { found } from "./data/values";
import { baseUrl, dashboards, openui, userId } from "./openui";
import { readDashboard } from "./program";

// A filter in a dashboard's plan. Which filters there are, their values and the periods are found
// in the database (data/values.ts), so nothing here names one: the chat's instructions list them
// (prompt.ts) and the plan is checked against them (brief.ts).
const filter = z.object({
  name: z.string().describe("A filter your instructions list, by its name."),
  value: z
    .string()
    .optional()
    .describe(
      "The value it opens on, when the request narrows to one: a value your instructions list for that filter, spelled as listed. Leave out to open on all.",
    ),
});

// The chat model's tools. `execute` runs on this server (the "use generative" compiler keeps it,
// and OpenUI Cloud, out of the browser bundle); `render` is the card the chat shows for the call.
// Each tool returns as soon as the dashboard has an id, while OpenUI Cloud generates it in the
// background. Its result, written by OpenUI Cloud, is a sentence for the model plus the
// dashboard's reference, which the card passes to the renderer as is.
export default defineToolkit({
  create_dashboard: {
    description:
      "Create a live dashboard. It loads its numbers from the data tools every time it is opened, so say what it should answer, without numbers. Returns right away while the dashboard is generated.",
    parameters: z.object({
      title: z
        .string()
        .min(1)
        .describe('A short title without the period, such as "Net sales by region".'),
      prompt: z
        .string()
        .min(1)
        .describe(
          "What the user wants to learn, in their own terms, and what it is for if they said. The builder reads the data tools itself and chooses the measures, the charts and the layout, so name one only if the user did. Leave out the period and the filters: `range` and `filters` set them, and every part of the dashboard follows them.",
        ),
      range: z
        .string()
        .optional()
        .describe(
          'The period the dashboard opens on, which the reader can change: one of the periods your instructions list, by its value, or exact dates as "YYYY-MM-DD..YYYY-MM-DD" for a request that names them, such as a calendar year or month. Leave out when the request names none.',
        ),
      filters: z
        .array(filter)
        .optional()
        .describe(
          "The filters the dashboard has besides the date, decided now so it is built around them: each filter your instructions list that the request splits by or narrows to, and any the user asked for. Leave out the ones it doesn't mention; the user can ask for those later.",
        ),
    }),
    // The plan (the period and the filters, read off the request) is written out for the builder
    // here, with which Queries pass each one, so no filter is left to chance.
    execute: async ({ title, prompt, range, filters = [] }, { abortSignal }) =>
      dashboards.create(
        { title, prompt: `${prompt}\n\n${await dashboardBrief(range, filters)}` },
        { userId: userId() },
        { signal: abortSignal },
      ),
    // In the message, not folded into the tool-call group.
    display: "standalone",
    render: (props) => <DashboardCard {...props} />,
  },
  edit_dashboard: {
    description:
      "Change a dashboard in place, such as adding a chart, a section or a filter. Returns right away; the user sees the new version when it is ready.",
    parameters: z.object({
      id: z.string().min(1).describe("The dashboard's artifact_id, art_…, from its tool result."),
      prompt: z
        .string()
        .min(1)
        .describe(
          "The change to make, in the user's terms. Which filters are added or taken away is decided by add_filters and remove_filters, not by this text, so for such a change say only that, and nothing about what else the dashboard shows.",
        ),
      add_filters: z
        .array(filter)
        .optional()
        .describe(
          "Filters the user wants added. A value they name picks the filter that has it: pass that filter with the value, whether or not the dashboard has it yet, without asking.",
        ),
      remove_filters: z
        .array(z.string())
        .optional()
        .describe("Filters the user wants taken away, each by its name."),
    }),
    execute: async ({ id, prompt, add_filters, remove_filters }, { abortSignal }) => {
      const data = await found();
      const names = data.filters.map(({ name }) => name);
      // The dashboard as it is, so the change is written against the filters it has and a new
      // card follows them. The frontend token reads only this visitor's dashboards. When the
      // program can't be read, or isn't whole yet, the change still goes, with the added filters
      // alone written out.
      const now = await openui
        .createFrontendToken({ userId: userId() }, { signal: abortSignal })
        .then(({ token }) =>
          fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(id)}`, {
            headers: { "x-thesys-frontend-token": token },
            signal: abortSignal,
          }),
        )
        .then((response) => (response.ok ? response.json() : undefined))
        .then((artifact?: { content?: unknown }) =>
          // Nothing for a program still being written: it may not have reached its filters.
          typeof artifact?.content === "string"
            ? readDashboard(artifact.content, names)
            : undefined,
        )
        .catch(() => undefined);
      const { brief, leftOut } = await filterChange(add_filters, remove_filters, now, data);
      const response = await dashboards.edit(
        { id, prompt: brief ? `${prompt}\n\n${brief}` : prompt },
        { userId: userId() },
        { signal: abortSignal },
      );
      // The result opens with a sentence for the model. A filter that was left out, because
      // nothing on the dashboard would change with it, is said first, so the reply doesn't claim it.
      return leftOut ? `${leftOut}\n\n${response}` : response;
    },
    // In the message, not folded into the tool-call group.
    display: "standalone",
    render: (props) => <DashboardCard {...props} />,
  },
});
