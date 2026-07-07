import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

type Options = {
  rootMargin?: string;
  threshold?: number;
  /** When false, observer stays detached (e.g. before data is ready). */
  enabled?: boolean;
};

/** Pause work for off-screen stickers/emojis (telegram-tt only plays visible stickers). */
export function useElementVisible(
  ref: RefObject<Element | null>,
  options?: Options,
): boolean {
  const [visible, setVisible] = useState(true);
  const [observedNode, setObservedNode] = useState<Element | null>(null);
  const enabled = options?.enabled !== false;

  useLayoutEffect(() => {
    setObservedNode(ref.current);
  });

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }

    const node = observedNode ?? ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const findScrollRoot = (start: Element): Element | null => {
      let el: Element | null = start.parentElement;
      while (el) {
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        if (
          overflowY === "auto" ||
          overflowY === "scroll" ||
          overflowY === "overlay"
        ) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    };

    const scrollRoot = findScrollRoot(node);

    let intersecting = false;
    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
        setVisible(intersecting);
      },
      {
        root: scrollRoot,
        rootMargin: options?.rootMargin ?? "64px",
        threshold: options?.threshold ?? 0.01,
      },
    );
    observer.observe(node);
    const rootRect = scrollRoot?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const margin = 250;
    const rootTop = rootRect?.top ?? 0;
    const rootBottom = rootRect?.bottom ?? window.innerHeight;
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > rootTop - margin &&
      rect.top < rootBottom + margin &&
      rect.right > (rootRect?.left ?? 0) &&
      rect.left < (rootRect?.right ?? window.innerWidth)
    ) {
      setVisible(true);
    }
    return () => {
      observer.disconnect();
    };
  }, [enabled, observedNode, options?.rootMargin, options?.threshold, ref]);

  return visible;
}
