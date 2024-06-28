import {ethers} from "ethers";

export const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

export async function getChainId(rpc) {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    return Number(network.chainId);
}

