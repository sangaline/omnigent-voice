#include <cstdio>
#include <string>

#include <moshi/moshi.h>

int main(int argc, char ** argv) {
    if (argc != 5) {
        std::fprintf(stderr,
            "usage: %s CONFIG INPUT_SAFETENSORS OUTPUT_GGUF DEVICE\n", argv[0]);
        return 2;
    }

    std::fprintf(stderr, "quantize: loading backends\n");
    ggml_backend_load_all();
    ggml_backend_t backend = ggml_backend_init_by_name(argv[4], nullptr);
    ggml_backend_t cpu = ggml_backend_init_by_type(
        GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
    if (!backend || !cpu) {
        std::fprintf(stderr, "failed to initialize inference backends\n");
        return 3;
    }

    std::fprintf(stderr, "quantize: reading config\n");
    moshi_config_t config;
    if (moshi_get_config(&config, argv[1]) != 0) return 4;
    config.model_type = "kame";
    config.cross_attention = false;
    config.tts_config.second_stream_ahead = 0;

    std::fprintf(stderr, "quantize: opening checkpoint\n");
    moshi_context_t * moshi = moshi_alloc(backend, cpu);
    moshi_lm_t * lm = moshi_lm_from_files(moshi, &config, argv[2]);
    if (!lm || !moshi_lm_quantize(lm, "q4_k")) return 5;
    std::fprintf(stderr, "quantize: loading and quantizing tensors\n");
    moshi_lm_load(lm);
    std::fprintf(stderr, "quantize: writing gguf\n");
    moshi_lm_save_gguf(lm, argv[3]);
    std::fprintf(stderr, "quantize: complete\n");

    unref(lm);
    unref(moshi);
    ggml_backend_free(cpu);
    ggml_backend_free(backend);
    return 0;
}
