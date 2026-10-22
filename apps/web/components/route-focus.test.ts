import { describe, expect, it, vi } from 'vitest';

import { focusPrimaryLandmarkWhenReady } from './route-focus';

interface FakeTarget {
  attributes: Map<string, string>;
  focus(options?: FocusOptions): void;
  getAttribute(name: string): string | null;
}

function target(attributes: Record<string, string>): FakeTarget {
  const values = new Map(Object.entries(attributes));
  return {
    attributes: values,
    focus: vi.fn<(options?: FocusOptions) => void>(),
    getAttribute: (name) => values.get(name) ?? null,
  };
}

describe('route focus management', () => {
  it('waits for client navigation loading UI to be replaced before focusing', () => {
    const loading = target({ 'aria-busy': 'true' });
    const detail = target({ tabindex: '-1' });
    let current: FakeTarget | null = loading;
    let contentChanged: () => void = () => undefined;
    const stopObserving = vi.fn();

    const cleanup = focusPrimaryLandmarkWhenReady({
      getMainContent: () => current,
      getPreferredTarget: () => null,
      hasPreferredTarget: () => false,
      isContentComplete: () => current === detail,
      observeContent: (callback) => {
        contentChanged = callback;
        return stopObserving;
      },
    });

    expect(loading.focus).not.toHaveBeenCalled();
    current = detail;
    contentChanged();
    expect(detail.focus).toHaveBeenCalledOnce();
    expect(detail.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(stopObserving).toHaveBeenCalledOnce();

    cleanup();
    contentChanged();
    expect(detail.focus).toHaveBeenCalledOnce();
  });

  it('focuses a completed initial, back, or error landmark immediately', () => {
    const main = target({ tabindex: '-1' });
    const stopObserving = vi.fn();

    focusPrimaryLandmarkWhenReady({
      getMainContent: () => main,
      getPreferredTarget: () => null,
      hasPreferredTarget: () => false,
      isContentComplete: () => true,
      observeContent: () => stopObserving,
    });

    expect(main.focus).toHaveBeenCalledOnce();
    expect(stopObserving).toHaveBeenCalledOnce();
  });

  it('does not focus a target that participates in normal tab order', () => {
    const main = target({ tabindex: '0' });
    const stopObserving = vi.fn();

    const cleanup = focusPrimaryLandmarkWhenReady({
      getMainContent: () => main,
      getPreferredTarget: () => null,
      hasPreferredTarget: () => false,
      isContentComplete: () => true,
      observeContent: () => stopObserving,
    });

    expect(main.focus).not.toHaveBeenCalled();
    cleanup();
    expect(stopObserving).toHaveBeenCalledOnce();
  });

  it('waits for and focuses an exact evidence-return origin instead of main', () => {
    const main = target({ tabindex: '-1' });
    const origin = target({ tabindex: '-1' });
    let currentOrigin: FakeTarget | null = null;
    const contentComplete = false;
    let contentChanged: () => void = () => undefined;
    const stopObserving = vi.fn();

    focusPrimaryLandmarkWhenReady({
      getMainContent: () => main,
      getPreferredTarget: () => currentOrigin,
      hasPreferredTarget: () => true,
      isContentComplete: () => contentComplete,
      observeContent: (callback) => {
        contentChanged = callback;
        return stopObserving;
      },
    });

    expect(main.focus).not.toHaveBeenCalled();
    currentOrigin = origin;
    contentChanged();
    expect(origin.focus).toHaveBeenCalledOnce();
    expect(origin.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(main.focus).not.toHaveBeenCalled();
  });

  it('falls back to main only after a preferred return target is conclusively absent', () => {
    const main = target({ tabindex: '-1' });
    let contentComplete = false;
    let contentChanged: () => void = () => undefined;
    const stopObserving = vi.fn();

    focusPrimaryLandmarkWhenReady({
      getMainContent: () => main,
      getPreferredTarget: () => null,
      hasPreferredTarget: () => true,
      isContentComplete: () => contentComplete,
      observeContent: (callback) => {
        contentChanged = callback;
        return stopObserving;
      },
    });

    expect(main.focus).not.toHaveBeenCalled();
    contentChanged();
    expect(main.focus).not.toHaveBeenCalled();

    contentComplete = true;
    contentChanged();
    expect(main.focus).toHaveBeenCalledOnce();
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(stopObserving).toHaveBeenCalledOnce();
  });

  it('focuses a generic completed error landmark when an evidence return target disappeared', () => {
    const errorMain = target({ tabindex: '-1' });
    const stopObserving = vi.fn();

    focusPrimaryLandmarkWhenReady({
      getMainContent: () => errorMain,
      getPreferredTarget: () => null,
      hasPreferredTarget: () => true,
      isContentComplete: () => true,
      observeContent: () => stopObserving,
    });

    expect(errorMain.focus).toHaveBeenCalledOnce();
    expect(stopObserving).toHaveBeenCalledOnce();
  });
});
