import { command, commandOrThrow } from "../../kit/tauri";


export const VoiceBridge = {
  voiceStart: (mode?: "assist") => commandOrThrow<void>("voice_start", { mode }),
  voiceSpeak: (text: string) => command<void>("voice_speak", { text }),
  voiceStop: () => command<void>("voice_stop"),
  voiceCancel: () => command<void>("voice_cancel"),
  voiceModelStatus: () => command<VoiceStatus>("voice_model_status"),
  voiceDownloadModel: () => commandOrThrow<void>("voice_download_model"),
  voiceDownloadWhisper: () => commandOrThrow<void>("voice_download_whisper"),
};

export interface VoiceStatus { ready: boolean; whisperReady: boolean; listening: boolean; hotkeyError: string }
