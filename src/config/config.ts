import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    WALLET_KEYPAIR: z.string()
        .optional()
        .default(""),
    RPC_URL: z.string().url(),
    USE_AWS: z.string().transform((str) => str === "true"),
    AWS_SECRET_NAME: z.string().nullable(),
    AWS_REGION: z.string().nullable()
});

const config = envSchema.parse(process.env);
export default config;
