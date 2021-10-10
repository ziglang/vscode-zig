const std = @import("std");
/// Zig version. When writing code that supports multiple versions of Zig, prefer
/// feature detection (i.e. with `@hasDecl` or `@hasField`) over version checks.
pub const zig_version = std.SemanticVersion.parse("0.8.0-dev.2703+c12704a33") catch unreachable;
/// Temporary until self-hosted is feature complete.
pub const zig_is_stage2 = false;
/// Temporary until self-hosted supports the `cpu.arch` value.
pub const stage2_arch: std.Target.Cpu.Arch = .x86_64;

pub const output_mode = std.builtin.OutputMode.Exe;
pub const link_mode = std.builtin.LinkMode.Dynamic;
pub const is_test = false;
pub const single_threaded = false;
pub const abi = std.Target.Abi.gnu;
pub const cpu: std.Target.Cpu = .{
    .arch = .x86_64,
    .model = &std.Target.x86.cpu.skylake,
    .features = std.Target.x86.featureSet(&[_]std.Target.x86.Feature{
        .@"64bit",
        .adx,
        .aes,
        .avx,
        .avx2,
        .bmi,
        .bmi2,
        .clflushopt,
        .cmov,
        .cx16,
        .cx8,
        .ermsb,
        .f16c,
        .false_deps_popcnt,
        .fast_15bytenop,
        .fast_gather,
        .fast_scalar_fsqrt,
        .fast_shld_rotate,
        .fast_variable_shuffle,
        .fast_vector_fsqrt,
        .fma,
        .fsgsbase,
        .fxsr,
        .idivq_to_divl,
        .invpcid,
        .lzcnt,
        .macrofusion,
        .mmx,
        .movbe,
        .nopl,
        .pclmul,
        .popcnt,
        .prfchw,
        .rdrnd,
        .rdseed,
        .sahf,
        .sgx,
        .slow_3ops_lea,
        .sse,
        .sse2,
        .sse3,
        .sse4_1,
        .sse4_2,
        .ssse3,
        .vzeroupper,
        .x87,
        .xsave,
        .xsavec,
        .xsaveopt,
        .xsaves,
    }),
};
pub const os = std.Target.Os{
    .tag = .macos,
    .version_range = .{ .semver = .{
        .min = .{
            .major = 11,
            .minor = 3,
            .patch = 1,
        },
        .max = .{
            .major = 11,
            .minor = 3,
            .patch = 1,
        },
    }},
};
pub const target = std.Target{
    .cpu = cpu,
    .os = os,
    .abi = abi,
};
pub const object_format = std.Target.ObjectFormat.macho;
pub const mode = std.builtin.Mode.Debug;
pub const link_libc = true;
pub const link_libcpp = false;
pub const have_error_return_tracing = true;
pub const valgrind_support = true;
pub const position_independent_code = true;
pub const position_independent_executable = true;
pub const strip_debug_info = false;
pub const code_model = std.builtin.CodeModel.default;
