## 0.6.12
- Remove syntax highlighting for async and await keywords
- Update minisign verification (@Techatrix)
- Address various issues with the ZLS config middleware (@Techatrix)

## 0.6.11
- Use Zig mirror list from ziglang.org

## 0.6.10
- Fix installing Zig 0.14.1 with new tarball name format

## 0.6.9
- Add config option for arguments used in test runner (@omissis)
- Add toggleMultilineStringLiteral command (@devhawk)
- Resolve file extensions and relative paths when looking up exe (@Techatrix)
- Improve error messages when executable path could not be resolved (@Techatrix)
- Prevent concurrent installations of exes that cause all of them to fail

## 0.6.8
- Fix regression in using config options placeholders in paths. 

## 0.6.7
- Windows: prefer tar.exe in system32 over $PATH if available (@Techatrix)
- Add a workaround for [ziglang/zig#21905](https://github.com/ziglang/zig/issues/21905) on MacOS and BSDs (@Techatrix)

## 0.6.5
- Prevent the extension from overriding options in `zls.json` with default values (@Techatrix)
- Fix various version management edge cases (@Techatrix)

## 0.6.4
- Prevent `.zig-cache` files from being automatically revealed in the explorer (@Techatrix)
- Add missing PowerShell call operator when using the run button (@BlueBlue21)
- Update ZLS options (@Techatrix)
- Look for zig in `$PATH` before defaulting to latest tagged release (@Techatrix)
- Offer to update workspace config when selecting Zig version (@Techatrix)
    - Selecting a different Zig version is no longer permanent by default and will reset
      to the previous version after a restart.
- Properly clean unused installations (@Techatrix)

## 0.6.3
- Fix boolean ZLS options being ignored (@Techatrix)
- Always refer to ZLS as "ZLS language server" (@Techatrix)
- Ensure paths sent to terminal are properly escaped

## 0.6.2
- Don't open every zig file in the workspace just to look for tests (@Techatrix)
- Sync ZLS options (@Techatrix)
- handle `zig.path` edge cases (@Techatrix)

## 0.6.1
- Fix formatting not working when `zig.formattingProvider` was set to ZLS (@Techatrix)

## 0.6.0
- Introduce a new fully featured version manager (@Techatrix)
- Add Zig test runner provider (@babaldotdev)

## 0.5.9
- Improve formatting provider implementation and default to using ZLS formatter (@Techatrix)
- Sync ZLS options (@Techatrix)
- Update ZLS install tool (@Techatrix)

## 0.5.8
- Fix updating a nightly version of Zig to a tagged release

## 0.5.7
- Remove `zig.zls.openopenconfig` (@Techatrix)
- Automatically add `zig` to `$PATH` in the integrated terminal (@Techatrix)
- Change `zig.path` and `zig.zls.path` `$PATH` lookup from empty string to executable name (@Techatrix)
    - The extension will handle the migration automatically
- Remove ouput channel for formatting (@Techatrix)
    - `ast-check` already provides the same errors inline.
- Allow predefined variables in all configuration options (@Jarred-Sumner) 

## 0.5.6
- Fix initial setup always being skippped (@Techatrix)

## 0.5.5
- Fix `zig.install` when no project is open
- Rework extension internals (@Techatrix)
- Show progress while downloading updates (@Techatrix)
- Link release notes in new Zig version notification

## 0.5.4
- Fix incorrect comparisons that caused ZLS not to be started automatically (@SuperAuguste)
- Ensure `zig.path` is valid in `zig.zls.install` (@unlsycn) 

## 0.5.3
- Fix checks on config values and versions
- Fix diagnostics from Zig compiler provider (@Techatrix)
- Ensure all commands are registered properly on extension startup

## 0.5.2
- Update ZLS config even when Zig is not found
- Disable autofix by default
- Make `zig.zls.path` and `zig.path` scoped as `machine-overridable` (@alexrp)
- Fix ZLS debug trace (@alexrp)
- Default `zig.path` and `zig.zls.path` to look up in PATH (@alexrp)

## 0.5.1
- Always use global configuration.

## 0.5.0
- Rework initial setup and installation management
- Add new zls hint settings (@leecannon)
- Update zls settings
- Fix C pointer highlighting (@tokyo4j)

## 0.4.3
- Fix checking for ZLS updates
- Always check `PATH` when `zigPath` is set to empty string
- Fix build on save when ast check provider is ZLS
- Delete old zls binary before renaming to avoid Windows permission error

## 0.4.2
- Fix `Specify path` adding a leading slash on windows (@sebastianhoffmann)
- Fix path given to `tar` being quoted
- Add option to use `zig` found in `PATH` as `zigPath`

## 0.4.1
- Fix formatting when `zigPath` includes spaces
- Do not default to `zig` in `PATH` anymore

## 0.4.0
- Prompt to install if prebuilt zls doesn't exist in specified path
- Add `string` to the `name` of `@""` tokens
- Add functionality to manage Zig installation

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
