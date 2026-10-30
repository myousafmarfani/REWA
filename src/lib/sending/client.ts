/**
 * WhatsApp Business Cloud API client for the sending pipeline.
 *
 * Credentials are never read from environment variables here — the
 * caller loads `wa_phone_number_id` + `wa_access_token` from
 * `client_config` (Model A per-client config, spec 1 A9) and passes
 * them in. The stored token is CIPHERTEXT; callers must decrypt it
 * (src/lib/whatsapp/encryption) before calling.
 *
 * Payload shapes mirror the wacrm fork's existing Meta client
 * (src/lib/whatsapp/meta-api.ts) — same endpoints, same fields.
 */

import { WaSendError, isRetryableHttpStatus } from './types';

const WA_API_VERSION = process.env.WA_API_VERSION ?? 'v21.0';
const WA_BASE_URL = process.env.WA_BASE_URL ?? 'https://graph.facebook.com';
const WA_BASE = `${WA_BASE_URL}/${WA_API_VERSION}`;

export interface SendTextParams {
  phoneNumberId: string;
  accessToken: string;
  to: string; // E.164
  body: string;
}

export interface SendTemplateParams {
  phoneNumberId: string;
  accessToken: string;
  to: string; // E.164
  templateName: string;
  languageCode: string; // Meta locale, e.g. 'en_US'
  components?: unknown[];
}

export interface SendResult {
  waMessageId: string;
}

interface MetaErrorEnvelope {
  error?: { message?: string; code?: number; type?: string };
}

/** Meta accepts any of its locale codes; the messages table stores a
 *  short default ('en'). Map collapsed codes to Meta's canonical form. */
const LANGUAGE_ALIASES: Record<string, string> = {
  en: 'en_US',
  pt: 'pt_BR',
  zh: 'zh_CN',
};

export function normalizeLanguageCode(code: string): string {
  return LANGUAGE_ALIASES[code] ?? code;
}

async function readMetaError(
  res: Response,
  fallback: string
): Promise<{ message: string; code: number | null }> {
  try {
    const data = (await res.json()) as MetaErrorEnvelope;
    return {
      message: data.error?.message ?? fallback,
      code: typeof data.error?.code === 'number' ? data.error.code : null,
    };
  } catch {
    return { message: fallback, code: null };
  }
}

function waErrorFrom(
  error: unknown,
  recipient: string,
  httpStatus?: number
): WaSendError {
  if (error instanceof WaSendError) return error;
  const message =
    error instanceof Error
      ? error.message
      : 'Network error reaching WhatsApp API';
  const retryable =
    error instanceof TypeError || isRetryableHttpStatus(httpStatus);
  return new WaSendError(message, {
    recipient,
    httpStatus: httpStatus ?? null,
    retryable,
  });
}

export async function sendTextMessage(
  params: SendTextParams
): Promise<SendResult> {
  const url = `${WA_BASE}/${params.phoneNumberId}/messages`;
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'text',
    text: { preview_url: false, body: params.body },
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (error) {
    throw waErrorFrom(error, params.to);
  }

  if (!res.ok) {
    const { message, code } = await readMetaError(
      res,
      `Meta API error: HTTP ${res.status}`
    );
    throw new WaSendError(message, {
      waErrorCode: code,
      httpStatus: res.status,
      recipient: params.to,
      retryable: isRetryableHttpStatus(res.status),
    });
  }

  const data = (await res.json()) as { messages?: Array<{ id?: string }> };
  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new WaSendError('Meta accepted the send but returned no message id', {
      httpStatus: res.status,
      recipient: params.to,
      retryable: false,
    });
  }
  return { waMessageId };
}

export async function sendTemplateMessage(
  params: SendTemplateParams
): Promise<SendResult> {
  const url = `${WA_BASE}/${params.phoneNumberId}/messages`;
  const template: Record<string, unknown> = {
    name: params.templateName,
    language: { code: normalizeLanguageCode(params.languageCode) },
  };
  if (params.components && params.components.length > 0) {
    template.components = params.components;
  }
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'template',
    template,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (error) {
    throw waErrorFrom(error, params.to);
  }

  if (!res.ok) {
    const { message, code } = await readMetaError(
      res,
      `Meta API error: HTTP ${res.status}`
    );
    throw new WaSendError(message, {
      waErrorCode: code,
      httpStatus: res.status,
      recipient: params.to,
      retryable: isRetryableHttpStatus(res.status),
    });
  }

  const data = (await res.json()) as { messages?: Array<{ id?: string }> };
  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new WaSendError('Meta accepted the send but returned no message id', {
      httpStatus: res.status,
      recipient: params.to,
      retryable: false,
    });
  }
  return { waMessageId };
}

export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | string;

/**
 * Read Meta's quality rating for the business phone number.
 * GET /{phone-number-id}?fields=quality_rating → GREEN | YELLOW | RED.
 * Used by the 6-hourly quality monitor.
 */
export async function fetchQualityRating(params: {
  phoneNumberId: string;
  accessToken: string;
}): Promise<QualityRating> {
  const url = `${WA_BASE}/${params.phoneNumberId}?fields=quality_rating`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
  } catch (error) {
    console.error('[sending:client] quality rating fetch failed', {
      phoneNumberId: params.phoneNumberId,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  if (!res.ok) {
    const { message } = await readMetaError(
      res,
      `Meta API error: HTTP ${res.status}`
    );
    throw new Error(message);
  }

  const data = (await res.json()) as { quality_rating?: string };
  return data.quality_rating ?? '';
}
