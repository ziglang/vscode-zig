## 0.3.2
- Make formatting provider option an enum (@alichraghi)
- Only apply onEnterRules when line starts with whitespace
- Highlight `.zon` files (@Techatrix)
- Fix `zls` not restarting after having been updated on macOS (@ngrilly)
- Support `${workspaceFolder}` in `zig.zls.path` (@Jarred-Sumner)
- Make semantic token configuration an enum

## 0.3.1
- Fix missing Linux AArch64 ZLS auto-installer support

## 0.3.0
 - Update syntax to Zig 0.10.x
 - Add support for optional [Zig Language Server](https://github.com/zigtools/zls) integration
 - Support `ast-check` diagnostics without language server integration
 - Minor fixes for existing extension features

## 0.2.5
 - Syntax updates (@Vexu)

## 0.2.4
 - Update syntax (@Vexu)
 - Fix provideCodeActions regression (@mxmn)
 - Add build-on-save setting (@Swoogan)
 - Add stderr to output panel (@Swoogan)
 - Add zig build to command palette (@Swoogan)

 Thanks to @Vexu for taking over keeping the project up to date.

## 0.2.3
 - Syntax updates
 - Improve diagnostics regex (@emekoi)
 - Fix eol on format (@emekoi)
 - Trim URI's to fix path issue (@emekoi)
 - Update unicode escape pattern match (@hryx)
 - Add configuration option for showing output channel on error (@not-fl3)

## 0.2.2
 - Add new usingnamespace keyword

## 0.2.1
 - Add correct filename to zig fmt output (@gernest)
 - Stop zig fmt error output taking focus on save (@CurtisFenner)

## 0.2.0
 - Syntax updates
 - Add built-in functions to syntax (@jakewakefield)
 - Add anyerror keyword (@Hejsil)
 - Add allowzero keyword (@emekoi)
 - Correctly find root of package using build.zig file (@gernest)
 - Use output channels for zig fmt error messages (@gernest)
 - Simplify defaults for automatic code-formatting (@hchac)

## 0.1.9
 - Highlight all bit size int types (@Hejsil)

## 0.1.8 16th July 2018
 - Add auto-formatting using `zig fmt`
 - Syntax updates

## 0.1.7 - 2nd March 2018
 - Async keyword updates
 - Build on save support (@Hejsil)

## 0.1.6 - 21st January 2018
 - Keyword updates for new zig
 - Basic linting functionality (@Hejsil)

## 0.1.5 - 23rd October 2017
 - Fix and/or word boundary display

## 0.1.4 - 23rd October 2017
 - Fix C string literals and allow escape characters (@scurest)

## 0.1.3 - 11th September 2017
 - Fix file extension

## 0.1.2 - 31st August 2017
 - Add new i2/u2 and align keywords

## 0.1.1 - 8th August 2017
 - Add new float/integer types

## 0.1.0 - 15th July 2017
 - Minimal syntax highlighting support
