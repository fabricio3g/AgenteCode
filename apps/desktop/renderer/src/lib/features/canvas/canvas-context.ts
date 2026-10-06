import { getContext } from 'svelte';
import { canvasBoard, CANVAS_CONTEXT, type CanvasBoardStore } from './canvas-board.svelte';
export const getCanvasBoard = (): CanvasBoardStore => getContext<CanvasBoardStore>(CANVAS_CONTEXT) ?? canvasBoard;
