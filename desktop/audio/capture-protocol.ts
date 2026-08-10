import { z } from "zod";

const formatSchema = z.object({
  sampleRate: z.literal(48000),
  channels: z.literal(1),
  frameMs: z.literal(10)
});

const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    pid: z.number().int().positive(),
    scope: z.enum(["process-tree", "system"]),
    format: formatSchema
  }),
  z.object({ type: z.literal("stop") })
]);

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sequence: z.number().int().nonnegative(),
    captureScope: z.enum(["process-tree", "system"])
  }),
  z.object({
    type: z.literal("level"),
    sequence: z.number().int().nonnegative(),
    peak: z.number().min(0).max(1)
  }),
  z.object({ type: z.literal("process-exited"), sequence: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("error"),
    sequence: z.number().int().nonnegative(),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type AudioCaptureCommand = z.infer<typeof commandSchema>;
export type AudioCaptureEvent = z.infer<typeof eventSchema>;

export function serializeCaptureCommand(command: AudioCaptureCommand): string {
  return `${JSON.stringify(commandSchema.parse(command))}\n`;
}

export function parseCaptureEvent(line: string): AudioCaptureEvent {
  return eventSchema.parse(JSON.parse(line.trim()));
}
