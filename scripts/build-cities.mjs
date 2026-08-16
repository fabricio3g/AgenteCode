/**
 * Generates the bundled city datasets for the map artifact.
 *
 * Run: `npm run build:cities`
 *
 * Source is the `all-the-cities` package (MIT), itself derived from GeoNames
 * (https://www.geonames.org/, CC BY 4.0). Only a build-time dependency — the
 * generated files are committed, so nothing is fetched at install or at runtime and
 * the map keeps rendering with no network.
 *
 * Output is an array of tuples rather than objects, because keys would dominate the
 * payload at this row count:
 *
 *   [name, lat, lng, populationThousands, countryCode]
 *
 * Coordinates are rounded to three decimals — about 100 m, far finer than a map whose
 * whole surface is 720 px wide can resolve.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cities from 'all-the-cities';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'renderer', 'src', 'lib', 'ui', 'data');

/**
 * Tiers mirror the atlas levels in `map-atlas.ts`: the small one ships with the world
 * view, the large one loads only once the viewport is regional.
 */
const TIERS = [
  { name: 'cities-major', minPopulation: 200_000 },
  { name: 'cities-detail', minPopulation: 30_000 }
];

mkdirSync(outDir, { recursive: true });

for (const tier of TIERS) {
  const rows = cities
    .filter((city) => city.population >= tier.minPopulation)
    // Descending population: the loader takes the first N in view, so ordering here
    // means it never has to sort at runtime.
    .sort((a, b) => b.population - a.population)
    .map((city) => [
      city.name,
      Number(city.loc.coordinates[1].toFixed(3)),
      Number(city.loc.coordinates[0].toFixed(3)),
      Math.round(city.population / 1000),
      city.country
    ]);

  const target = join(outDir, `${tier.name}.json`);
  writeFileSync(target, JSON.stringify(rows), 'utf8');
  const kb = Math.round(Buffer.byteLength(JSON.stringify(rows)) / 1024);
  console.log(`${tier.name}: ${rows.length} cities (pop >= ${tier.minPopulation.toLocaleString()}), ${kb} kB`);
}
