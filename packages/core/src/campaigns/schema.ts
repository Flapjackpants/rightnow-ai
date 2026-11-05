import { z } from "zod";
import { isValidTimeZone } from "../schedule";

const esp = z.enum(["all", "google", "outlook", "other"]);
const espRule = z.strictObject({
  action: z.enum(["send", "do_not_send"]),
  recipientEsp: esp,
  senderEsp: esp,
});
export type EspRule = z.infer<typeof espRule>;

const sec = z.number().int().min(0).max(86400);
const limit = z.number().int().min(1).nullable();
const emails = z.array(z.email().max(254)).max(10);
const text = (n: number) => z.string().trim().min(1).max(n);

export const campaignFields = {
  name: text(200),
  evergreen: z.boolean(),
  dailyLimit: limit,
  maxNewLeadsPerDay: z.number().int().min(0).nullable(), // 0 = no new leads (M10)
  perCompanyDailyLimit: limit,
  minGapSec: sec,
  randomGapSec: sec,
  stopOnReply: z.boolean(),
  stopOnAutoReply: z.boolean(),
  stopForCompanyOnReply: z.boolean(),
  trackOpens: z.boolean(),
  trackClicks: z.boolean(),
  textOnly: z.boolean(),
  firstEmailTextOnly: z.boolean(),
  prioritizeNewLeads: z.boolean(),
  matchProvider: z.boolean(),
  espRoutingRules: z.array(espRule).max(20),
  accountTags: z.array(text(50)).max(50),
  allowRisky: z.boolean(),
  allowCatchAll: z.boolean(),
  bounceProtect: z.boolean(),
  // D19: every campaign email carries List-Unsubscribe, so the toggle only accepts true.
  unsubscribeHeader: z.literal(true, { error: "unsubscribe_header_required" }),
  unsubscribeLink: z.boolean(),
  optOutText: text(300).nullable(),
  cc: emails,
  bcc: emails,
  ownerId: text(100).nullable(),
  plValue: z.number().min(0).max(1e12).nullable(),
  tags: z.array(text(50)).max(50),
  abAutoOptimize: z.boolean(),
  abWinnerMetric: z.enum(["reply", "click", "open"]).nullable(),
  abResetDaily: z.boolean(),
};

const combined = (v: { cc?: string[]; bcc?: string[] }) =>
  (v.cc?.length ?? 0) + (v.bcc?.length ?? 0) <= 10;
const ccMsg = { message: "cc and bcc together may hold at most 10 addresses", path: ["cc"] };

export const campaignCreateSchema = z
  .strictObject(campaignFields)
  .partial()
  .required({ name: true })
  .refine(combined, ccMsg);
export const campaignPatchSchema = z.strictObject(campaignFields).partial().refine(combined, ccMsg);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const PRESETS = {
  anyTime: { days: 127, from: "00:00", to: "24:00" },
  officeHours: { days: 62, from: "09:00", to: "17:00" },
} as const;

export const scheduleSchema = z
  .strictObject({
    name: text(100),
    timezone: z.string().refine(isValidTimeZone, "invalid_timezone").optional(),
    days: z.number().int().min(1).max(127), // Sun = bit 0; 0 would never send
    from: hhmm,
    to: z.union([hhmm, z.literal("24:00")]),
  })
  // from > to is an overnight window; equal bounds are an empty or ambiguous one.
  .refine((s) => s.from !== s.to, { message: "from and to must differ", path: ["to"] });
const ymd = z.iso.date();
export const schedulesSchema = z.strictObject({
  schedules: z.array(scheduleSchema).min(1).max(10),
  startDate: ymd.nullish(),
  endDate: ymd.nullish(),
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;
