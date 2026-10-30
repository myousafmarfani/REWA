"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface EmbeddingRow {
  id: string;
  property_id: string;
  chunk_type: string;
  availability: string;
  content: string;
}

interface ChunkDraft {
  chunk_type: string;
  content: string;
}

interface PropertyGroup {
  property_id: string;
  chunks: EmbeddingRow[];
  chunkTypes: string[];
}

const CHUNK_TYPES = [
  "overview",
  "pricing",
  "availability",
  "location",
  "amenities",
  "payment_plan",
  "specs",
];

export default function PropertiesPage() {
  const { canEditSettings } = useAuth();
  const [rows, setRows] = useState<EmbeddingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [propertyId, setPropertyId] = useState("");
  const [chunks, setChunks] = useState<ChunkDraft[]>([
    { chunk_type: "overview", content: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("property_embeddings")
      .select("id, property_id, chunk_type, availability, content")
      .order("property_id", { ascending: true });
    if (error) {
      toast.error("Could not load properties", { description: error.message });
    } else {
      setRows((data as EmbeddingRow[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo<PropertyGroup[]>(() => {
    const map = new Map<string, EmbeddingRow[]>();
    for (const r of rows) {
      const list = map.get(r.property_id) ?? [];
      list.push(r);
      map.set(r.property_id, list);
    }
    return Array.from(map.entries()).map(([property_id, list]) => ({
      property_id,
      chunks: list,
      chunkTypes: Array.from(new Set(list.map((c) => c.chunk_type))),
    }));
  }, [rows]);

  const updateChunk = useCallback(
    (index: number, patch: Partial<ChunkDraft>) => {
      setChunks((prev) =>
        prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
      );
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!propertyId.trim()) {
      toast.error("Enter a property ID");
      return;
    }
    const valid = chunks.filter((c) => c.content.trim());
    if (valid.length === 0) {
      toast.error("Add at least one non-empty chunk");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/properties/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: propertyId.trim(),
          chunks: valid.map((c) => ({
            chunk_type: c.chunk_type,
            content: c.content.trim(),
          })),
        }),
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(p?.error ?? `Ingest failed (${res.status})`);
      }
      toast.success("Property data ingested");
      setPropertyId("");
      setChunks([{ chunk_type: "overview", content: "" }]);
      load();
    } catch (err) {
      toast.error("Could not ingest property", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [propertyId, chunks, load]);

  const deleteProperty = useCallback(
    async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("property_embeddings")
        .delete()
        .eq("property_id", id);
      if (error) {
        toast.error("Could not delete property", { description: error.message });
      } else {
        setRows((prev) => prev.filter((r) => r.property_id !== id));
        toast.success("Property removed");
      }
    },
    [],
  );

  if (!canEditSettings) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Property data is admin-only.
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Property data</h1>
        <p className="text-sm text-muted-foreground">
          Grounds the agent&apos;s answers in pgvector. Every property fact
          the agent states must come from here.
        </p>
      </div>

      {/* Ingest form */}
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Ingest a property</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="property-id">Property ID</Label>
          <Input
            id="property-id"
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            placeholder="e.g. MARINA-TOWER-A-1204"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Chunks</Label>
          {chunks.map((chunk, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-lg border border-border p-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={chunk.chunk_type}
                  list="chunk-types"
                  className="w-40"
                  onChange={(e) => updateChunk(i, { chunk_type: e.target.value })}
                />
                <datalist id="chunk-types">
                  {CHUNK_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove chunk"
                  disabled={chunks.length === 1}
                  onClick={() =>
                    setChunks((prev) => prev.filter((_, idx) => idx !== i))
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              <Textarea
                value={chunk.content}
                rows={3}
                placeholder="The fact text the agent may quote for this chunk type…"
                onChange={(e) => updateChunk(i, { content: e.target.value })}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() =>
              setChunks((prev) => [...prev, { chunk_type: "overview", content: "" }])
            }
          >
            <Plus /> Add chunk
          </Button>
        </div>

        <Button onClick={submit} disabled={submitting} className="self-start">
          {submitting ? <Loader2 className="animate-spin" /> : null}
          Ingest property
        </Button>
      </Card>

      {/* Existing properties */}
      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : groups.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No property data yet.
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <Card key={g.property_id} className="gap-2 p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">
                  {g.property_id}
                </span>
                <Badge variant="outline">{g.chunks.length} chunks</Badge>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Delete ${g.property_id}`}
                  onClick={() => deleteProperty(g.property_id)}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.chunkTypes.map((t) => (
                  <Badge key={t} variant="secondary">
                    {t}
                  </Badge>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
