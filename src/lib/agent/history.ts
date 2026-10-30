import { supabaseAdmin } from '@/lib/supabase/admin'
import type { ConversationHistoryMessage } from './types'

/**
 * Load the last `limit` messages for a conversation, oldest-first, as a
 * Vercel AI SDK `messages` array. Inbound → 'user', outbound → 'assistant'.
 */
export async function loadHistory(
  conversationId: string,
  clientId: string,
  limit = 20,
): Promise<ConversationHistoryMessage[]> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('direction, body')
    .eq('conversation_id', conversationId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[agent:history] failed to load history', {
      conversationId,
      clientId,
      error: error.message,
    })
    return []
  }

  // Oldest-first for the model.
  return (data ?? []).reverse().map((row) => ({
    role: (row.direction === 'inbound' ? 'user' : 'assistant') as
      | 'user'
      | 'assistant',
    content: row.body,
  }))
}

/**
 * Build the retrieval query from the inbound message plus the last three
 * exchanges of existing history (bounded to the final message of each).
 */
export function buildRetrievalQuery(
  inboundMessage: string,
  history: ConversationHistoryMessage[],
  exchanges = 3,
): string {
  const recent = history.slice(-exchanges * 2)
  const turns = recent
    .map((m) => `${m.role === 'user' ? 'Contact' : 'Agent'}: ${m.content}`)
    .join('\n')
  return turns ? `${turns}\nContact: ${inboundMessage}` : inboundMessage
}