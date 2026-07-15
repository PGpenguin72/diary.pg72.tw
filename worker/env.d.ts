// Worker secrets are not declared in wrangler.jsonc, so `wrangler types` cannot
// emit them into the generated Env. This augmentation only adds the optional
// secret; every other binding stays generated. Do not hand-write vars here.
interface Env {
  AUTH_CLIENT_SECRET?: string;
}
