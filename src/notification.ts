/** What a server may ask for. The text is fixed here, so nothing a server sends is shown. */
export type Kind = "mention" | "dm" | "message";

export const KINDS: readonly Kind[] = ["mention", "dm", "message"];

export interface Alert {
  title: string;
  body: string;
  /** Lets the phone tell which of its servers this came from. */
  tag: string;
  /** Sealed by the server to the phone (GRYT-1688). Passed through unread; the text above is the fallback. */
  preview?: string;
}

/** base64url of a version byte, a nonce, ciphertext and tag. Its shape only: the relay never opens it. */
export const PREVIEW_SHAPE = /^[A-Za-z0-9_-]{40,2048}$/;

const BODY: Record<Kind, string> = {
  mention: "Someone mentioned you",
  dm: "New direct message",
  message: "New message",
};

export function alertFor(kind: Kind, tag: string, preview?: string): Alert {
  return { title: "Gryt", body: BODY[kind], tag, ...(preview ? { preview } : {}) };
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; reason: string };
