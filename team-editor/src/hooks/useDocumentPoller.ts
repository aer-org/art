import { useState, useEffect, useRef, useCallback } from 'react';

interface UseDocumentPollerReturn {
  content: string | null;
  prevContent: string | null;
  hasChanged: boolean;
  isLoading: boolean;
}

export function useDocumentPoller(
  filePath: string,
  intervalMs = 2000,
): UseDocumentPollerReturn {
  const [content, setContent] = useState<string | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [hasChanged, setHasChanged] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const lastContentRef = useRef<string | null>(null);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFile = useCallback(async () => {
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        if (res.status === 404) {
          setIsLoading(false);
          return;
        }
        return;
      }
      const text = await res.text();
      setIsLoading(false);

      if (lastContentRef.current !== null && text !== lastContentRef.current) {
        setPrevContent(lastContentRef.current);
        setHasChanged(true);

        // Auto-reset hasChanged after 3s
        if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
        changeTimerRef.current = setTimeout(() => {
          setHasChanged(false);
          setPrevContent(null);
        }, 3000);
      }

      lastContentRef.current = text;
      setContent(text);
    } catch {
      // Network error — ignore, will retry
    }
  }, [filePath]);

  useEffect(() => {
    fetchFile();
    const id = setInterval(fetchFile, intervalMs);
    return () => {
      clearInterval(id);
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    };
  }, [fetchFile, intervalMs]);

  return { content, prevContent, hasChanged, isLoading };
}
