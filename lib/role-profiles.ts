import { z } from "zod";
import {
  assistantRoleIds,
  assistantRoleSchema,
  builtInRoleProfiles,
  validateRoleTemplate,
  type AssistantRole,
  type RoleProfile
} from "./assistant-role";
import { fetchDesktopControlJson } from "./runtime-config";

const profileSchema = z.object({
  role: assistantRoleSchema,
  label: z.string().max(30).optional(),
  openingTemplate: z.string().max(500),
  closingTemplate: z.string().max(500),
  instructions: z.string().trim().min(1).max(4000),
  configVersion: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null)
});

export async function getRoleProfiles(): Promise<Record<AssistantRole, RoleProfile>> {
  const data = await fetchDesktopControlJson<{ roles?: unknown[] }>("/api/v1/client/settings/roles");
  const result = structuredClone(builtInRoleProfiles);
  if (!Array.isArray(data?.roles)) return result;
  for (const raw of data.roles) {
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success || !validateRoleTemplate(parsed.data.openingTemplate) || !validateRoleTemplate(parsed.data.closingTemplate)) continue;
    const role = parsed.data.role;
    result[role] = { ...parsed.data, label: builtInRoleProfiles[role].label };
  }
  return assistantRoleIds.every((role) => result[role]) ? result : structuredClone(builtInRoleProfiles);
}

export async function getRoleProfile(role: AssistantRole) {
  return (await getRoleProfiles())[role];
}
