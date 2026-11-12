FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server python3 && rm -rf /var/lib/apt/lists/*
RUN useradd --no-create-home --shell /bin/sh recovery && passwd -d recovery && mkdir -p /run/sshd /recovery && chown recovery:recovery /recovery && chmod 0700 /recovery
RUN rm -f /etc/ssh/ssh_host_*
EXPOSE 2222
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]
