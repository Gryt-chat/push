/** What a server may ask for. The text is fixed here, so nothing a server sends is shown. */
export type Kind = "mention" | "dm" | "message";

export const KINDS: readonly Kind[] = ["mention", "dm", "message"];

export interface Alert {
  title: string;
  body: string;
  /** Lets the phone tell which of its servers this came from. */
  tag: string;
}

const BODY: Record<Kind, string> = {
  mention: "Someone mentioned you",
  dm: "New direct message",
  message: "New message",
};

export function alertFor(kind: Kind, tag: string): Alert {
  return { title: "Gryt", body: BODY[kind], tag };
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; reason: string };
