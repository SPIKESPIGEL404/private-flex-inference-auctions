# Build from the explicitly pinned runtime base published by this repository.
ARG RUNTIME_BASE=private-market:baseline-b-a08e3ec@sha256:b7cf6a781837086173f160d06a2f44e1c86317e13b09ee4c94c5cb34640a75d9
FROM ${RUNTIME_BASE}
USER 0:0
COPY --chown=0:0 . /opt/package/
RUN cp /opt/package/bootstrap_chutes.py /opt/market/bootstrap_chutes.py && \
    cp /opt/package/runtime_chutes.py /opt/market/runtime_chutes.py && \
    cp /opt/package/public_tls.py /opt/market/public_tls.py && \
    cp /opt/package/attestation.json /opt/market/attestation.custom-domain.json && \
    cp /opt/package/nginx.conf /opt/market/nginx.conf && \
    chmod 444 /opt/package/* /opt/market/bootstrap_chutes.py /opt/market/runtime_chutes.py /opt/market/public_tls.py /opt/market/attestation.custom-domain.json /opt/market/nginx.conf
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/opt/package/entrypoint.py"]
