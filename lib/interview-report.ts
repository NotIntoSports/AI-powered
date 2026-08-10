import { z } from "zod";

export const interviewReportSchema = z.object({
  generatedAt: z.string(),
  summary: z.string().min(1).max(2000),
  evidence: z.array(z.object({
    topic: z.string().min(1).max(100),
    observation: z.string().min(1).max(500),
    quotes: z.array(z.string().min(1).max(300)).max(5)
  })).max(12),
  strengths: z.array(z.string().min(1).max(300)).max(10),
  followUps: z.array(z.string().min(1).max(300)).max(10),
  limitations: z.array(z.string().min(1).max(300)).max(10),
  humanReviewRequired: z.literal(true)
});

export type InterviewReport = z.infer<typeof interviewReportSchema>;

export const modelReportSchema = interviewReportSchema.omit({
  generatedAt: true,
  humanReviewRequired: true
});
