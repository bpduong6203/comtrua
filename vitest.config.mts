import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				isolatedStorage: false,
				remoteBindings: false,
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
