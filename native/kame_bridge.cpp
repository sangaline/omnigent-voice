#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <string_view>
#include <unistd.h>
#include <vector>

#include <moshi/moshi.h>

namespace {

constexpr int kControlFd = 3;
constexpr int kEventsFd = 4;

struct Options {
    const char * config = nullptr;
    const char * model = nullptr;
    const char * mimi = nullptr;
    const char * tokenizer = nullptr;
    const char * device = "Vulkan0";
    int context = 3000;
};

[[noreturn]] void usage(const char * program) {
    std::fprintf(stderr,
        "usage: %s --config PATH --model PATH --mimi PATH --tokenizer PATH "
        "[--device NAME] [--context FRAMES]\n",
        program);
    std::exit(2);
}

Options parse_options(int argc, char ** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument(argv[index]);
        if (index + 1 >= argc) usage(argv[0]);
        const char * value = argv[++index];
        if (argument == "--config") options.config = value;
        else if (argument == "--model") options.model = value;
        else if (argument == "--mimi") options.mimi = value;
        else if (argument == "--tokenizer") options.tokenizer = value;
        else if (argument == "--device") options.device = value;
        else if (argument == "--context") options.context = std::atoi(value);
        else usage(argv[0]);
    }
    if (!options.config || !options.model || !options.mimi || !options.tokenizer ||
        options.context <= 0) {
        usage(argv[0]);
    }
    return options;
}

bool read_full(int fd, void * destination, size_t bytes) {
    auto * output = static_cast<unsigned char *>(destination);
    size_t offset = 0;
    while (offset < bytes) {
        const ssize_t count = ::read(fd, output + offset, bytes - offset);
        if (count == 0) return false;
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += static_cast<size_t>(count);
    }
    return true;
}

bool write_full(int fd, const void * source, size_t bytes) {
    const auto * input = static_cast<const unsigned char *>(source);
    size_t offset = 0;
    while (offset < bytes) {
        const ssize_t count = ::write(fd, input + offset, bytes - offset);
        if (count < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        offset += static_cast<size_t>(count);
    }
    return true;
}

void event(std::string_view line) {
    if (::fcntl(kEventsFd, F_GETFD) < 0) return;
    write_full(kEventsFd, line.data(), line.size());
    write_full(kEventsFd, "\n", 1);
}

std::string spoken_piece(tokenizer_t * tokenizer, int token) {
    std::string piece = tokenizer_id_to_piece(tokenizer, token);
    const std::string marker = "\xE2\x96\x81";
    size_t position = 0;
    while ((position = piece.find(marker, position)) != std::string::npos) {
        piece.replace(position, marker.size(), " ");
        ++position;
    }
    return piece;
}

void drain_controls(
    moshi_lm_gen_t * generator,
    tokenizer_t * tokenizer,
    std::string & pending
) {
    if (::fcntl(kControlFd, F_GETFD) < 0) return;
    char buffer[4096];
    while (true) {
        const ssize_t count = ::read(kControlFd, buffer, sizeof(buffer));
        if (count > 0) pending.append(buffer, static_cast<size_t>(count));
        else if (count < 0 && errno == EINTR) continue;
        else break;
    }

    size_t newline = 0;
    while ((newline = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, newline);
        pending.erase(0, newline + 1);
        const bool reset = line.starts_with("R\t") || line == "R";
        const bool append = line.starts_with("A\t") || line == "A";
        if (!reset && !append) {
            event("E\tinvalid control command");
            continue;
        }
        const char * text = line.size() > 2 ? line.c_str() + 2 : "";
        const int tokens = moshi_lm_kame_oracle_text(
            generator, tokenizer, text, reset);
        event("G\t" + std::to_string(tokens));
    }
}

double percentile(std::vector<double> values, double quantile) {
    std::sort(values.begin(), values.end());
    const auto index = static_cast<size_t>(
        quantile * static_cast<double>(values.size() - 1));
    return values[index];
}

void report_metrics(std::vector<double> & frame_ms) {
    if (frame_ms.size() < 125) return;
    double total = 0.0;
    for (const double value : frame_ms) total += value;
    const double mean = total / static_cast<double>(frame_ms.size());
    char line[256];
    std::snprintf(line, sizeof(line),
        "M\t{\"frames\":%zu,\"mean_ms\":%.3f,\"p95_ms\":%.3f,"
        "\"p99_ms\":%.3f,\"max_ms\":%.3f}",
        frame_ms.size(), mean, percentile(frame_ms, 0.95),
        percentile(frame_ms, 0.99), percentile(frame_ms, 1.0));
    event(line);
    frame_ms.clear();
}

}  // namespace

int main(int argc, char ** argv) {
    const Options options = parse_options(argc, argv);

    const int audio_output = ::dup(STDOUT_FILENO);
    if (audio_output < 0 || ::dup2(STDERR_FILENO, STDOUT_FILENO) < 0) return 3;
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    ggml_backend_load_all();
    ggml_backend_t backend = ggml_backend_init_by_name(options.device, nullptr);
    if (!backend) {
        std::fprintf(stderr, "failed to initialize requested backend\n");
        return 4;
    }
    ggml_backend_t cpu = ggml_backend_init_by_type(
        GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
    if (!cpu) {
        std::fprintf(stderr, "failed to initialize CPU backend\n");
        return 5;
    }

    moshi_config_t config;
    if (moshi_get_config(&config, options.config) != 0) return 6;
    config.model_type = "kame";
    config.cross_attention = false;
    config.tts_config.second_stream_ahead = 0;
    config.context = options.context;

    moshi_context_t * moshi = moshi_alloc(backend, cpu);
    moshi_lm_t * lm = moshi_lm_from_files(moshi, &config, options.model);
    if (!lm) return 7;
    moshi_lm_load(lm);

    mimi_codec_t * codec = mimi_alloc(moshi, options.mimi, 8);
    mimi_encode_context_t * encoder = mimi_encode_alloc_context(codec);
    mimi_decode_context_t * decoder = mimi_decode_alloc_context(codec);
    tokenizer_t * tokenizer = tokenizer_alloc(options.tokenizer, false);
    moshi_lm_gen_t * generator = moshi_lm_generator(lm);
    moshi_lm_kame_oracle_text(generator, tokenizer, "", true);
    moshi_lm_start(moshi, generator, 0.8f, 0.7f);

    const int control_flags = ::fcntl(kControlFd, F_GETFL);
    if (control_flags >= 0) ::fcntl(kControlFd, F_SETFL, control_flags | O_NONBLOCK);

    std::fflush(stdout);
    if (::dup2(audio_output, STDOUT_FILENO) < 0) return 8;
    ::close(audio_output);

    const int frame_size = mimi_frame_size(codec);
    event("R\t{\"sample_rate\":24000,\"frame_rate\":12.5,\"frame_size\":" +
        std::to_string(frame_size) + "}");

    std::vector<float> input(frame_size);
    std::vector<float> output(frame_size, 0.0f);
    std::vector<int16_t> tokens(8);
    std::vector<double> frame_ms;
    std::string controls;
    std::string transcript;
    int text_token = 0;

    while (read_full(STDIN_FILENO, input.data(), input.size() * sizeof(float))) {
        drain_controls(generator, tokenizer, controls);
        const auto started = std::chrono::steady_clock::now();
        mimi_encode_send(encoder, input.data());
        mimi_encode_receive(encoder, tokens.data());
        moshi_lm_send2(generator, tokens);
        std::fill(output.begin(), output.end(), 0.0f);
        if (moshi_lm_receive(generator, text_token, tokens)) {
            mimi_decode_send(decoder, tokens.data());
            mimi_decode_receive(decoder, output.data());
        }
        const auto finished = std::chrono::steady_clock::now();
        frame_ms.push_back(std::chrono::duration<double, std::milli>(
            finished - started).count());
        report_metrics(frame_ms);

        if (text_token != 0 && text_token != 3) {
            transcript += spoken_piece(tokenizer, text_token);
        } else if (!transcript.empty()) {
            event("T\t" + transcript);
            transcript.clear();
        }
        if (!write_full(STDOUT_FILENO, output.data(), output.size() * sizeof(float))) {
            break;
        }
    }

    if (!transcript.empty()) event("T\t" + transcript);
    unref(generator);
    unref(tokenizer);
    unref(decoder);
    unref(encoder);
    unref(codec);
    unref(lm);
    unref(moshi);
    ggml_backend_free(cpu);
    ggml_backend_free(backend);
    return 0;
}
