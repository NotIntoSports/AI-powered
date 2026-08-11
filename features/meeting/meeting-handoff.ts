export type MeetingHandoffInput = {
  prerequisitesReady: boolean;
  software: string;
  videoConfirmed: boolean;
  audioConfirmed: boolean;
};

export function canConfirmMeetingHandoff(input: MeetingHandoffInput) {
  return input.prerequisitesReady &&
    Boolean(input.software.trim()) &&
    input.videoConfirmed &&
    input.audioConfirmed;
}
