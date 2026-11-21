FROM alpine:latest
ARG GREETING=hello
RUN echo "$GREETING from hullport" > /greeting.txt
RUN cat /greeting.txt
CMD ["cat", "/greeting.txt"]
