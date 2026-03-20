import { useState, useEffect, useRef, useCallback } from 'react';

interface UseDocumentPollerReturn {
  content: string | null;
  prevContent: string | null;
  hasChanged: boolean;
  isLoading: boolean;
  pendingReview: boolean;
  resolveReview: (finalContent: string | null) => Promise<void>;
}

export function useDocumentPoller(
  filePath: string,
  intervalMs = 2000,
): UseDocumentPollerReturn {
  const [content, setContent] = useState<string | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [hasChanged, setHasChanged] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingReview, setPendingReview] = useState(false);

  // Snapshot of content before the first unreviewed change.
  // Fixed while reviewing — diff is always base vs latest.
  const baseContentRef = useRef<string | null>(null);
  const lastContentRef = useRef<string | null>(null);

  const fetchFile = useCallback(async () => {
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        if (res.status === 404) setIsLoading(false);
        return;
      }
      const text = await res.text();
      setIsLoading(false);

      const previousContent = lastContentRef.current;
      lastContentRef.current = text;

      if (previousContent !== null && text !== previousContent) {
        // Content changed since last poll
        if (baseContentRef.current === null) {
          // First change — snapshot the pre-change state as diff base
          baseContentRef.current = previousContent;
        }
        // Always diff base vs latest (accumulates multiple AI edits)
        setPrevContent(baseContentRef.current);
        setContent(text);
        setHasChanged(true);
        setPendingReview(true);
      } else if (baseContentRef.current === null) {
        // No change, not in review — update displayed content
        setContent(text);
      }
      // In review but no new change this poll — keep current diff as-is
    } catch {
      // Network error — will retry next interval
    }
  }, [filePath]);

  const resolveReview = useCallback(
    async (finalContent: string | null) => {
      if (finalContent !== null) {
        // Write user-modified content back to file
        await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
          method: 'PUT',
          body: finalContent,
        });
        setContent(finalContent);
        lastContentRef.current = finalContent;
      }
      // Reset review state — next change starts a fresh diff
      baseContentRef.current = null;
      setPrevContent(null);
      setHasChanged(false);
      setPendingReview(false);
    },
    [filePath],
  );

  useEffect(() => {
    fetchFile();
    const id = setInterval(fetchFile, intervalMs);
    return () => clearInterval(id);
  }, [fetchFile, intervalMs]);

  return { content, prevContent, hasChanged, isLoading, pendingReview, resolveReview };
}
