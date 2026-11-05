import type { JobDef } from "../boss";
import { abOptimizeJob } from "./ab-optimize";
import { accountsAutoResumeJob } from "./accounts-auto-resume";
import { accountsAutofixJob } from "./accounts-autofix";
import { backgroundJobsJob } from "./background-jobs";
import { campaignDispatchJob } from "./campaign-dispatch";
import { campaignPlanJob } from "./campaign-plan";
import { deliverabilityHealthJob } from "./deliverability-health";
import { dnsCheckJob } from "./dns-check";
import { eventDispatchJob } from "./event-dispatch";
import { leadImportJob } from "./lead-import";
import { leadSourceJob } from "./lead-source";
import { leadVerifyJob } from "./lead-verify";
import { mailSyncJob } from "./mail-sync";
import { pushRenewJob } from "./push-renew";
import { sendRecoveryJob } from "./send-recovery";
import { retentionJob } from "./retention";
import { warmupTickJob } from "./warmup-tick";
import { webhookDeliverJob } from "./webhook-deliver";

// Later phases register their jobs here.
export const jobs: JobDef[] = [
  accountsAutoResumeJob,
  accountsAutofixJob,
  leadImportJob,
  leadSourceJob,
  leadVerifyJob,
  campaignPlanJob,
  campaignDispatchJob,
  sendRecoveryJob,
  mailSyncJob,
  dnsCheckJob,
  deliverabilityHealthJob,
  warmupTickJob,
  eventDispatchJob,
  abOptimizeJob,
  webhookDeliverJob,
  backgroundJobsJob,
  pushRenewJob,
  retentionJob,
];
