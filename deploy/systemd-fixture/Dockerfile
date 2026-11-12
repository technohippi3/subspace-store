FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd dbus python3 openssl openssh-server libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
RUN systemctl mask ssh.service ssh.socket
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
