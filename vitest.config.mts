import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Os testes de scripts executam bash real com docker/systemctl falsos e levam
    // 10 a 30 s cada no runner do CI sob 4 workers. 20 s de teto derrubou a PR #111.
    testTimeout: 60_000,
  },
});
