# Remote target for integration tests: sshd + C/C++ toolchain + CMake + gdb.
#   docker build -t remote-dev-target test/docker
#   docker run -d --rm -p 2222:22 --name remote-dev-target remote-dev-target
#   RD_TEST_HOST=dev@127.0.0.1:2222 RD_TEST_PASSWORD=dev npm run test:remote
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server build-essential cmake ninja-build gdb rsync ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dev && echo 'dev:dev' | chpasswd \
    && mkdir -p /run/sshd \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
