/**
 * Utility functions for config management.
 * Pure functions that can be easily tested and reused.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Converts a string to a URL-safe slug.
 * @param input - The string to slugify
 * @returns A lowercase, hyphen-separated slug
 * @example
 * slugify('Hello World') // 'hello-world'
 * slugify('My Model Name!') // 'my-model-name'
 */
export function slugify(input: string | null | undefined): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

/**
 * Deep merges a source object into a target object.
 * Only merges plain objects (not arrays). Arrays are replaced entirely.
 * @param target - The base object to merge into
 * @param source - The object with new values
 * @returns The merged target object (mutated in place)
 * @example
 * deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } })
 * // Returns: { a: 1, b: { c: 2, d: 3 } }
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T> | null | undefined
): T {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    const targetValue = target[key as keyof T];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      target[key as keyof T] = deepMerge(
        targetValue as Record<string, unknown>,
        value as Record<string, unknown>
      ) as T[keyof T];
    } else {
      target[key as keyof T] = value as T[keyof T];
    }
  }
  return target;
}

/**
 * Creates a deep clone of an object using structured cloning.
 * @param obj - The object to clone
 * @returns A deep copy of the object
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Safely reads a JSON file with error handling.
 * @param filePath - Absolute path to the JSON file
 * @param fallback - Value to return if file doesn't exist or is invalid
 * @returns The parsed JSON data or the fallback value
 */
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

/**
 * Safely writes a JSON file with error handling.
 * Creates parent directories if they don't exist.
 * @param filePath - Absolute path to the JSON file
 * @param value - The data to write
 * @returns true if write succeeded, false otherwise
 */
export function writeJsonSafe<T>(filePath: string, value: T): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    return true;
  } catch {
    return false;
  }
}