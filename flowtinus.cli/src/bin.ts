#!/usr/bin/env bun
import { main } from './main';

const { code, output } = await main(process.argv.slice(2), process.cwd());
process.stdout.write(output);
process.exit(code);
