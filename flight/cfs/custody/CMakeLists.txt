project(CUSTODY_APP C)

# The signer is the same portable C as flight/ (custody.c, sha256.c) plus TweetNaCl,
# which the Docker build places next to it. TweetNaCl is compiled unmodified with its
# own warnings silenced; the app and signer build under the mission's normal flags.
add_cfe_app(custody
  fsw/src/custody_app.c
  fsw/src/custody.c
  fsw/src/sha256.c
  fsw/src/tweetnacl.c
)
set_source_files_properties(fsw/src/tweetnacl.c PROPERTIES COMPILE_FLAGS "-w")
target_include_directories(custody PUBLIC fsw/inc fsw/src)
