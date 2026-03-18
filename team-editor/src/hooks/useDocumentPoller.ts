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
  const lastContentRef = useRef<string | null>(null);
  const pendingReviewRef = useRef(false);

  const fetchFile = useCallback(async () => {
    // Pause polling updates while user is reviewing a diff
    if (pendingReviewRef.current) return;

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        if (res.status === 404) setIsLoading(false);
        return;
      }
      const text = await res.text();
      setIsLoading(false);

      if (lastContentRef.current !== null && text !== lastContentRef.current) {
        setPrevContent(lastContentRef.current);
        setHasChanged(true);
        setPendingReview(true);
        pendingReviewRef.current = true;
      }

      lastContentRef.current = text;
      setContent(text);
    } catch {
      // Network error — will retry next interval
    }
  }, [filePath]);

  const resolveReview = useCallback(
    async (finalContent: string | null) => {
      if (finalContent !== null) {
        // Write modified content back to file
        await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
          method: 'PUT',
          body: finalContent,
        });
        setContent(finalContent);
        lastContentRef.current = finalContent;
      }
      setPrevContent(null);
      setHasChanged(false);
      setPendingReview(false);
      pendingReviewRef.current = false;
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
