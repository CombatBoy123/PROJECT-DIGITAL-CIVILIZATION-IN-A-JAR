import type { CivWorldTestHook } from './test-hook';

declare global {
  interface Window {
    /** Present while a WorldView is mounted (see test-hook.ts). */
    __civWorldTestHook?: CivWorldTestHook;
  }
}
