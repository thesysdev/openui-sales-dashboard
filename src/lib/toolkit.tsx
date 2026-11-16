"use generative";

import { defineToolkit } from "@assistant-ui/react";
import { z } from "zod";
import { DashboardCard } from "../components/dashboard";
import { dashboardBrief, filterChange, readDashboard } from "./brief";
import { chatCases } from "./data/about";
import { DEFAULT_RANGE, FILTER_NAMES, RANGES, RANGE_VALUES } from "./data/filters";
import { baseUrl, dashboards, openui, userId } from "./openui";

// A filter in a dashboard's plan. The names are the data's own (data/filters.ts).
const filter = z.object({
  name: z.enum(FILTER_NAMES),
  value: z
    .string()
    .optional()
    .describe("The value it opens on, when the request narrows to one. Leave out to open on all."),
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
        .describe(`A short title without the period, such as ${JSON.stringify(chatCases.title)}.`),
      prompt: z
        .string()
        .min(1)
        .describe(
          "What the user wants to learn, in their own terms, and what it is for if they said. The builder reads the data tools itself and chooses the measures, the charts and the layout, so name one only if the user did. Leave out the period and the filters: `range` and `filters` set them, and every part of the dashboard follows them.",
        ),
      range: z
        .enum(RANGE_VALUES)
        .optional()
        .describe(
          `The period the dashboard opens on, which the reader can change: ${RANGES.map(({ value, label }) => `"${value}" ${label.toLowerCase()}`).join(", ")}. Default "${DEFAULT_RANGE}".`,
        ),
      filters: z
        .array(filter)
        .optional()
        .describe(
          `The filters the dashboard has besides the date, decided now so it is built around them: each of ${FILTER_NAMES.join(", ")} that the request splits by or narrows to, and any the user asked for. Leave out the ones it doesn't mention; the user can ask for those later.`,
        ),
    }),
    // The plan (the period and the filters, read off the request) is written out for the builder
    // here, with which Queries pass each one, so no filter is left to chance.
    execute: ({ title, prompt, range = DEFAULT_RANGE, filters = [] }, { abortSignal }) =>
      dashboards.create(
        { title, prompt: `${prompt}\n\n${dashboardBrief(range, filters)}` },
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
          "The change to make. Leave out a filter to add or take away: add_filters and remove_filters carry it, and what the dashboard shows stays.",
        ),
      add_filters: z
        .array(filter)
        .optional()
        .describe(
          "Filters the user wants added. A value they name picks the filter that has it: pass that filter with the value, whether or not the dashboard has it yet, without asking.",
        ),
      remove_filters: z
        .array(z.enum(FILTER_NAMES))
        .optional()
        .describe("Filters the user wants taken away, each one named."),
    }),
    execute: async ({ id, prompt, add_filters, remove_filters }, { abortSignal }) => {
      // The dashboard as it is, so the change is written against the filters it has and a new
      // card follows them. The frontend token reads only this visitor's dashboards. When the
      // program can't be read the change still goes, with the added filters alone written out.
      const now = await openui
        .createFrontendToken({ userId: userId() }, { signal: abortSignal })
        .then(({ token }) =>
          fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(id)}`, {
            headers: { "x-thesys-frontend-token": token },
            signal: abortSignal,
          }),
        )
        .then((response) => response.json())
        .then(({ content }: { content?: unknown }) =>
          typeof content === "string" && content ? readDashboard(content) : undefined,
        )
        .catch(() => undefined);
      const filters = filterChange(add_filters, remove_filters, now);
      return dashboards.edit(
        { id, prompt: filters ? `${prompt}\n\n${filters}` : prompt },
        { userId: userId() },
        { signal: abortSignal },
      );
    },
    // In the message, not folded into the tool-call group.
    display: "standalone",
    render: (props) => <DashboardCard {...props} />,
  },
});
