"use generative";

import { defineToolkit } from "@assistant-ui/react";
import { z } from "zod";
import { DashboardCard } from "../components/dashboard";
import { RANGE_VALUES } from "./data/filters";
import { dashboardBrief } from "./filter-bar";
import { dashboards, userId } from "./openui";

// The chat model's tools. `execute` runs on this server (the "use generative" compiler keeps it,
// and OpenUI Cloud, out of the browser bundle); `render` is the card the chat shows for the call.
// Each tool returns as soon as the dashboard has an id, while OpenUI Cloud generates it in the
// background. Its result, written by OpenUI Cloud, is a sentence for the model plus the
// dashboard's reference, which the card passes to the renderer as is.
export default defineToolkit({
  create_dashboard: {
    description:
      "Create a live sales dashboard. It loads its numbers live from the Neon sales database every time it is opened, so describe what to show (sections, metrics, charts, tables) without numbers. Returns right away while the dashboard is generated.",
    parameters: z.object({
      title: z
        .string()
        .min(1)
        .describe('A short title without the period, such as "Net sales by region".'),
      prompt: z
        .string()
        .min(1)
        .describe(
          "What the dashboard should show: what the user wants to learn, and the measures and breakdowns that answer it. Name a chart or a layout only if the user did; the builder chooses the rest from its own components. Leave out the period: `range` sets it, and every part of the dashboard follows it.",
        ),
      range: z
        .enum(RANGE_VALUES)
        .optional()
        .describe(
          'The period the dashboard opens on, which the reader can change: "1m" last month, "3m" last quarter, "12m" last year, "lifetime" everything. Default "3m".',
        ),
    }),
    // The builder picks the filters, by what the dashboard shows. Added here are what they have
    // to do (start on the period asked for, be followed by every query) and the parts every
    // dashboard has, whatever the model's description leaves out.
    execute: ({ title, prompt, range = "3m" }, { abortSignal }) =>
      dashboards.create(
        { title, prompt: `${prompt}\n\n${dashboardBrief(range)}` },
        { userId: userId() },
        { signal: abortSignal },
      ),
    // In the message, not folded into the tool-call group.
    display: "standalone",
    render: (props) => <DashboardCard {...props} />,
  },
  edit_dashboard: {
    description:
      "Change a dashboard in place, such as adding a chart or a section. Returns right away; the user sees the new version when it is ready.",
    parameters: z.object({
      id: z.string().min(1).describe("The dashboard's artifact_id, art_…, from its tool result."),
      prompt: z.string().min(1).describe("The change to make."),
    }),
    execute: ({ id, prompt }, { abortSignal }) =>
      dashboards.edit({ id, prompt }, { userId: userId() }, { signal: abortSignal }),
    // In the message, not folded into the tool-call group.
    display: "standalone",
    render: (props) => <DashboardCard {...props} />,
  },
});
