export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      campaign_contacts: {
        Row: {
          campaign_id: string
          client_id: string
          contact_id: string
          created_at: string
          fail_reason: string | null
          failed_at: string | null
          id: string
          params: Json | null
          sent_at: string | null
          status: string
          wa_message_id: string | null
        }
        Insert: {
          campaign_id: string
          client_id: string
          contact_id: string
          created_at?: string
          fail_reason?: string | null
          failed_at?: string | null
          id?: string
          params?: Json | null
          sent_at?: string | null
          status?: string
          wa_message_id?: string | null
        }
        Update: {
          campaign_id?: string
          client_id?: string
          contact_id?: string
          created_at?: string
          fail_reason?: string | null
          failed_at?: string | null
          id?: string
          params?: Json | null
          sent_at?: string | null
          status?: string
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_contacts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "campaign_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          failed_count: number
          id: string
          name: string
          paused_reason: string | null
          scheduled_at: string | null
          sent_count: number
          started_at: string | null
          status: string
          template_id: string
          template_name: string | null
          total_contacts: number
          updated_at: string
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          name: string
          paused_reason?: string | null
          scheduled_at?: string | null
          sent_count?: number
          started_at?: string | null
          status?: string
          template_id: string
          template_name?: string | null
          total_contacts?: number
          updated_at?: string
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          name?: string
          paused_reason?: string | null
          scheduled_at?: string | null
          sent_count?: number
          started_at?: string | null
          status?: string
          template_id?: string
          template_name?: string | null
          total_contacts?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      client_config: {
        Row: {
          agent_language: string
          agent_persona_name: string
          agent_sign_off: string
          agent_tone: string
          client_brand_name: string
          client_id: string
          created_at: string
          escalation_phrase: string
          id: string
          notification_email: string | null
          region_priority: string[]
          updated_at: string
          wa_access_token: string | null
          wa_phone_number_id: string | null
          wa_webhook_secret: string | null
        }
        Insert: {
          agent_language?: string
          agent_persona_name?: string
          agent_sign_off?: string
          agent_tone?: string
          client_brand_name: string
          client_id: string
          created_at?: string
          escalation_phrase?: string
          id?: string
          notification_email?: string | null
          region_priority?: string[]
          updated_at?: string
          wa_access_token?: string | null
          wa_phone_number_id?: string | null
          wa_webhook_secret?: string | null
        }
        Update: {
          agent_language?: string
          agent_persona_name?: string
          agent_sign_off?: string
          agent_tone?: string
          client_brand_name?: string
          client_id?: string
          created_at?: string
          escalation_phrase?: string
          id?: string
          notification_email?: string | null
          region_priority?: string[]
          updated_at?: string
          wa_access_token?: string | null
          wa_phone_number_id?: string | null
          wa_webhook_secret?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_config_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_config_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "client_config_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      contact_imports: {
        Row: {
          client_id: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          filename: string
          id: string
          imported_by: string | null
          row_count_clean: number
          row_count_duplicate: number
          row_count_invalid: number
          row_count_raw: number
          row_count_review: number
          status: string
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          filename: string
          id?: string
          imported_by?: string | null
          row_count_clean?: number
          row_count_duplicate?: number
          row_count_invalid?: number
          row_count_raw?: number
          row_count_review?: number
          status?: string
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          filename?: string
          id?: string
          imported_by?: string | null
          row_count_clean?: number
          row_count_duplicate?: number
          row_count_invalid?: number
          row_count_raw?: number
          row_count_review?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_imports_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_imports_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "contact_imports_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "contact_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          assigned_to: string | null
          carrier: string | null
          client_id: string
          consent_at: string | null
          consent_source: string | null
          created_at: string
          email: string | null
          email_type: string | null
          follow_up_at: string | null
          full_name: string | null
          hot_flagged_at: string | null
          human_controlled: boolean
          id: string
          invalid_reason: string | null
          is_premium: boolean
          last_contacted_at: string | null
          last_inbound_at: string | null
          last_reply_at: string | null
          lead_score: string
          lead_source: string | null
          number_type: string | null
          opt_out_message_id: string | null
          opted_out: boolean
          opted_out_at: string | null
          opted_out_source: string | null
          phone_e164: string
          pipeline_stage: string
          priority_rank: number | null
          raw_import: Json | null
          region: string | null
          requirements: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          carrier?: string | null
          client_id: string
          consent_at?: string | null
          consent_source?: string | null
          created_at?: string
          email?: string | null
          email_type?: string | null
          follow_up_at?: string | null
          full_name?: string | null
          hot_flagged_at?: string | null
          human_controlled?: boolean
          id?: string
          invalid_reason?: string | null
          is_premium?: boolean
          last_contacted_at?: string | null
          last_inbound_at?: string | null
          last_reply_at?: string | null
          lead_score?: string
          lead_source?: string | null
          number_type?: string | null
          opt_out_message_id?: string | null
          opted_out?: boolean
          opted_out_at?: string | null
          opted_out_source?: string | null
          phone_e164: string
          pipeline_stage?: string
          priority_rank?: number | null
          raw_import?: Json | null
          region?: string | null
          requirements?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          carrier?: string | null
          client_id?: string
          consent_at?: string | null
          consent_source?: string | null
          created_at?: string
          email?: string | null
          email_type?: string | null
          follow_up_at?: string | null
          full_name?: string | null
          hot_flagged_at?: string | null
          human_controlled?: boolean
          id?: string
          invalid_reason?: string | null
          is_premium?: boolean
          last_contacted_at?: string | null
          last_inbound_at?: string | null
          last_reply_at?: string | null
          lead_score?: string
          lead_source?: string | null
          number_type?: string | null
          opt_out_message_id?: string | null
          opted_out?: boolean
          opted_out_at?: string | null
          opted_out_source?: string | null
          phone_e164?: string
          pipeline_stage?: string
          priority_rank?: number | null
          raw_import?: Json | null
          region?: string | null
          requirements?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "contacts_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_opt_out_message_id_fkey"
            columns: ["opt_out_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_to: string | null
          client_id: string
          contact_id: string
          created_at: string
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          status: string
          unread_count: number
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          client_id: string
          contact_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          status?: string
          unread_count?: number
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          client_id?: string
          contact_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          status?: string
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_score_history: {
        Row: {
          changed_at: string
          client_id: string
          contact_id: string
          id: string
          message_id: string | null
          new_score: string
          previous_score: string | null
          reason: string | null
        }
        Insert: {
          changed_at?: string
          client_id: string
          contact_id: string
          id?: string
          message_id?: string | null
          new_score: string
          previous_score?: string | null
          reason?: string | null
        }
        Update: {
          changed_at?: string
          client_id?: string
          contact_id?: string
          id?: string
          message_id?: string | null
          new_score?: string
          previous_score?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_score_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_score_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "lead_score_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_score_history_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_score_history_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          approved_at: string | null
          body_text: string
          category: string
          client_id: string
          created_at: string
          id: string
          language: string
          last_verified_at: string | null
          meta_template_id: string | null
          name: string
          rejected_reason: string | null
          status: string
          updated_at: string
          variable_count: number
        }
        Insert: {
          approved_at?: string | null
          body_text: string
          category?: string
          client_id: string
          created_at?: string
          id?: string
          language?: string
          last_verified_at?: string | null
          meta_template_id?: string | null
          name: string
          rejected_reason?: string | null
          status?: string
          updated_at?: string
          variable_count?: number
        }
        Update: {
          approved_at?: string | null
          body_text?: string
          category?: string
          client_id?: string
          created_at?: string
          id?: string
          language?: string
          last_verified_at?: string | null
          meta_template_id?: string | null
          name?: string
          rejected_reason?: string | null
          status?: string
          updated_at?: string
          variable_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "message_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "message_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          agent_follow_up_reason: string | null
          agent_intent_type: string | null
          agent_lead_score: string | null
          agent_needs_follow_up: boolean | null
          agent_signals: Json | null
          agent_suggested_stage: string | null
          body: string
          client_id: string
          contact_id: string
          conversation_id: string
          created_at: string
          direction: string
          id: string
          sender_type: string
          status: string
          wa_message_id: string | null
          wa_timestamp: string | null
        }
        Insert: {
          agent_follow_up_reason?: string | null
          agent_intent_type?: string | null
          agent_lead_score?: string | null
          agent_needs_follow_up?: boolean | null
          agent_signals?: Json | null
          agent_suggested_stage?: string | null
          body: string
          client_id: string
          contact_id: string
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          sender_type: string
          status?: string
          wa_message_id?: string | null
          wa_timestamp?: string | null
        }
        Update: {
          agent_follow_up_reason?: string | null
          agent_intent_type?: string | null
          agent_lead_score?: string | null
          agent_needs_follow_up?: boolean | null
          agent_signals?: Json | null
          agent_suggested_stage?: string | null
          body?: string
          client_id?: string
          contact_id?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          sender_type?: string
          status?: string
          wa_message_id?: string | null
          wa_timestamp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      property_embeddings: {
        Row: {
          availability: string
          chunk_type: string
          client_id: string
          content: string
          created_at: string
          embedding: string | null
          id: string
          metadata: Json | null
          property_id: string
          updated_at: string
        }
        Insert: {
          availability?: string
          chunk_type: string
          client_id: string
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          property_id: string
          updated_at?: string
        }
        Update: {
          availability?: string
          chunk_type?: string
          client_id?: string
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_embeddings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_embeddings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "property_embeddings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          client_id: string
          created_at: string
          email: string
          full_name: string
          id: string
          role: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          email: string
          full_name: string
          id: string
          role?: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          client_id: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          user_id: string
        }
        Insert: {
          auth: string
          client_id: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          user_id: string
        }
        Update: {
          auth?: string
          client_id?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      accounts: {
        Row: {
          created_at: string | null
          default_currency: string | null
          id: string | null
          name: string | null
          owner_id: string | null
          owner_user_id: string | null
          slug: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          default_currency?: never
          id?: string | null
          name?: string | null
          owner_id?: string | null
          owner_user_id?: never
          slug?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          default_currency?: never
          id?: string | null
          name?: string | null
          owner_id?: string | null
          owner_user_id?: never
          slug?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_id: string | null
          account_role: string | null
          avatar_url: string | null
          beta_features: string[] | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string | null
          role: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          account_id?: string | null
          account_role?: string | null
          avatar_url?: never
          beta_features?: never
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string | null
          role?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          account_id?: string | null
          account_role?: string | null
          avatar_url?: never
          beta_features?: never
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string | null
          role?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      current_client_id: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      match_property_embeddings: {
        Args: {
          p_client_id: string
          p_match_count: number
          p_match_threshold: number
          p_query_embedding: string
        }
        Returns: {
          chunk_type: string
          content: string
          metadata: Json
          property_id: string
          similarity: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
