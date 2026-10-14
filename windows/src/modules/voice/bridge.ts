import { command, commandOrThrow } from "../../core/bridge";


export const VoiceBridge = {
  voiceStart: () => commandOrThrow<void>("voice_start"),
  voiceStop: () => command<void>("voice_stop"),
  voiceCancel: () => command<void>("voice_cancel"),
  voiceModelStatus: () => command<VoiceStatus>("voice_model_status"),
  voiceDownloadModel: () => commandOrThrow<void>("voice_download_model"),
};

export interface VoiceStatus { ready: boolean; listening: boolean; hotkeyError: string }
